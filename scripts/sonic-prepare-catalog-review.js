"use strict";

// Bounded catalog coverage probe. No embeddings, production ranking or playback.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { publicTrack } = require("../src/sonicEnsembleEvaluation");
const { freezeSonicSourceSnapshot, assertSonicSourceSnapshot } = require("../src/sonicCandidateCorpus");
const { normalizeArtistCredits, matchBeatportVersionToTidal } = require("../src/beatportVersionMatch");
const { scoreTidalIdentity } = require("../src/exactTrackVerification");
const { wslPath } = require("../src/sonicAnalysisWorker");
const { validateWave } = require("./sonic-prepare-blind-review");
const ROOT = path.resolve(__dirname, "..");
const BASE = path.join(ROOT, "data/sonic-anchor-experiment-20261007");
const CACHE = path.join(ROOT, "data/sonic-blind-audio");
const sha = value => createHash("sha256").update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
function save(file, value, exclusive = true) {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  if (exclusive) fs.writeFileSync(file, bytes, { flag: "wx" });
  else { const temporary = file + "." + randomUUID() + ".tmp"; fs.writeFileSync(temporary, bytes, { flag: "wx" }); fs.renameSync(temporary, file); }
}
function privateDirectory(value) {
  const data = fs.realpathSync(path.join(ROOT, "data")), directory = path.resolve(ROOT, value);
  const relative = path.relative(data, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw Error("Choose a fresh child directory inside private data/.");
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realRelative = path.relative(data, fs.realpathSync(ancestor));
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw Error("Private output resolves outside data/.");
  return directory;
}
function argsFor(argv) {
  const [stage, flag, value] = argv;
  if (!["init", "collect", "cache", "publish", "report"].includes(stage) || argv.length !== 3 || flag !== "--output") throw Error("Use init|collect|cache|publish|report --output data/<private-catalog-review>.");
  return { stage, directory: privateDirectory(value) };
}
function withDb(callback, writable = false) {
  const db = new DatabaseSync(path.join(ROOT, "data/rabbit-hole-memory.sqlite"), { readOnly: !writable });
  db.exec("PRAGMA busy_timeout=5000");
  if (!writable) db.exec("PRAGMA query_only=ON; BEGIN");
  try { return callback(db); } finally { if (!writable) db.exec("ROLLBACK"); db.close(); }
}
function init(directory) {
  if (fs.existsSync(directory)) throw Error("Initialization requires a fresh private directory.");
  const baseline = read(path.join(BASE, "plan.json"));
  const targets = ["tidal:91463750", "tidal:355413959"];
  const anchors = withDb(db => targets.map(key => {
    const item = baseline.originalManifest.items.find(row => row.track.identityKey === key);
    assert.ok(item, "The exact frozen anchor is missing.");
    const batches = db.prepare("SELECT batch_id,private_plan_json FROM sonic_blind_review_batch ORDER BY created_at DESC").all();
    for (const row of batches) {
      const old = JSON.parse(row.private_plan_json), group = old.groups.find(g => g.anchor.identityKey === key);
      if (!group) continue;
      const clip = old.clips[group.anchorClip];
      assert.equal(clip.sourceSha256, item.track.analysisLocal.sha256);
      const wav = fs.readFileSync(path.join(CACHE, clip.clipId + ".wav"));
      assert.equal(sha(wav), clip.wavSha256); validateWave(path.join(CACHE, clip.clipId + ".wav"), clip);
      return { track: group.anchor, clip, origin: { batchId: old.batchId, sessionId: group.sessionId } };
    }
    throw Error("A verified cached anchor excerpt is required.");
  }));
  fs.mkdirSync(directory); fs.mkdirSync(path.join(directory, "audio"));
  save(path.join(directory, "request.json"), {
    version: 1, roundId: "catalog-coverage-20261007", createdAt: new Date().toISOString(),
    title: "Candidate coverage listening check", anchors,
    queries: { "tidal:91463750": ["Blazy", "Aura Vortex"], "tidal:355413959": ["S.P.L Project"] },
    broadIdentityKeys: ["tidal:348255917", "tidal:392687743"], ownArtistCount: 2,
    maxQueries: 3, maxResultsPerQuery: 12, maxVerificationAttemptsPerAnchor: 8,
    order: "fixed-query-round-robin; numeric-TIDAL-id; distinct-base-work; first-exact",
    purpose: "Development candidate coverage only; not a held-out model comparison.",
    originalManifestDigest: sha(baseline.originalManifest), productionApplied: false
  });
  console.log(JSON.stringify({ initialized: true, anchors: anchors.length, targetPairs: 8 }));
}
const baseWork = track => String(track.title || "").toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, "").replace(/[^a-z0-9]/g, "");
const yearTrack = track => {
  const out = { ...publicTrack(track) }, value = String(out.year || out.releaseDate || "");
  if (/^\d{4}/.test(value)) out.year = Number(value.slice(0, 4)); else delete out.year;
  return out;
};
function probe(file) {
  const prefix = process.env.SONIC_ANALYSIS_ENV_ROOT || "/home/darth/micromamba-root/envs/rabbit-hole-mert2";
  const result = execFileSync("wsl.exe", ["-d", "Ubuntu", "--", prefix + "/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", wslPath(file)], { windowsHide: true, timeout: 30000, encoding: "utf8" });
  const duration = Number(result.trim());
  if (!Number.isFinite(duration) || duration < 30 || duration > 7200) throw Error("A complete thirty-second source excerpt is required.");
  return duration;
}
async function collect(directory) {
  const request = read(path.join(directory, "request.json"));
  const baseline = read(path.join(BASE, "plan.json"));
  assert.equal(sha(baseline.originalManifest), request.originalManifestDigest);
  const file = path.join(directory, "collection.json");
  const progress = fs.existsSync(file) ? read(file) : { requestDigest: sha(request), pages: [], references: [], attempts: [] };
  assert.equal(progress.requestDigest, sha(request));
  const mark = () => save(file, progress, false);
  const config = require("../src/config"), { TidalVerifier } = require("../src/tidalVerifier"), { BeatportClient } = require("../src/beatportClient");
  const tidal = new TidalVerifier({ ...config.tidal, catalogPaginationFile: path.join(directory, "tidal-catalog-pagination.json") });
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const bp = new BeatportClient({ ...config.beatport, logger: quiet, maxSearchPages: 1, maxSearchQueries: 1, maxRetries: 0 });
  const token = bp.store.read();
  bp.accessToken = token.accessToken || bp.accessToken; bp.refreshToken = ""; bp.clientId = "";
  bp.store = { read: () => ({}), save: () => { throw Error("Private coverage collection cannot refresh authentication."); } };
  if (!tidal.isConfigured() || !bp.isConfigured()) throw Error("Configured catalog access is required; no authentication was changed.");
  if (token.expiresAtMs && token.expiresAtMs - Date.now() < 30000) throw Error("Beatport access token is expired; collection did not refresh it.");
  const original = new Set(baseline.originalManifest.items.map(x => x.track.identityKey));
  const anchorIsrc = new Set(baseline.originalManifest.items.filter(x => request.anchors.some(a => a.track.identityKey === x.track.identityKey)).map(x => x.track.isrc).filter(Boolean));
  const judgments = withDb(db => new Set(db.prepare("SELECT s.anchor_identity_key,i.candidate_identity_key FROM sonic_review_session s JOIN sonic_review_session_item i USING(session_id) WHERE i.status<>'PENDING'").all().map(x => x.anchor_identity_key + "|" + x.candidate_identity_key)));
  const frozen = read(path.join(BASE, "source-preparation.json"));
  for (const anchor of request.anchors) for (const key of request.broadByAnchor?.[anchor.track.identityKey] || request.broadIdentityKeys) {
    if (progress.references.some(x => x.selection.anchorIdentityKey === anchor.track.identityKey && x.track.identityKey === key)) continue;
    assert.ok(!judgments.has(anchor.track.identityKey + "|" + key), "Reference pair was already judged.");
    const candidate = frozen.candidates.find(x => x.track.identityKey === key);
    assert.ok(candidate, "Frozen broad reference is missing.");
    const sourceFile = path.join(BASE, "audio", candidate.source.sourceSha256 + ".audio");
    assertSonicSourceSnapshot(candidate.source, { track: candidate.track, audioBytes: fs.readFileSync(sourceFile) });
    progress.references.push({ track: candidate.track, verification: candidate.verification, source: candidate.source, sourceFile,
      selection: { kind: "broad-psy", source: "frozen-catalog-sampling", query: "Psy-Trance (soft sampling)", anchorIdentityKey: anchor.track.identityKey } }); mark();
  }
  for (const anchor of request.anchors) {
    const key = anchor.track.identityKey, queries = request.queries[key];
    const expectedOwn = request.ownArtistCountsByAnchor?.[key] ?? request.ownArtistCount;
    if (progress.references.filter(x => x.selection.anchorIdentityKey === key && x.selection.kind === "same-artist").length === expectedOwn) continue;
    for (const query of queries) if (!progress.pages.some(x => x.query === query)) {
      if (progress.pages.length >= request.maxQueries) throw Error("Sealed query budget exceeded.");
      const tracks = await tidal.searchTracks(query, { limit: 12, detailLimit: 0, fullPage: false, pageCount: 1, rotateCatalog: false });
      progress.pages.push({ query, tracks, fetchedAt: new Date().toISOString() }); mark();
      console.log(JSON.stringify({ query, returned: tracks.length }));
    }
    const lists = queries.map(query => progress.pages.find(x => x.query === query).tracks
      .filter(t => normalizeArtistCredits(t.artist).includes(normalizeArtistCredits(query)[0]))
      .sort((a, b) => String(a.tidalId || a.id).localeCompare(String(b.tidalId || b.id), "en", { numeric: true }))
      .map(track => ({ track, query })));
    const ordered = Array.from({ length: 12 }, (_, index) => lists.map(list => list[index]).filter(Boolean)).flat();
    for (const item of ordered) {
      const own = progress.references.filter(x => x.selection.anchorIdentityKey === key && x.selection.kind === "same-artist");
      if (own.length === expectedOwn) break;
      if (progress.attempts.filter(x => x.anchorIdentityKey === key).length >= request.maxVerificationAttemptsPerAnchor) break;
      const id = String(item.track.tidalId || item.track.id || ""), identityKey = "tidal:" + id;
      if (!/^\d+$/.test(id) || original.has(identityKey) || judgments.has(key + "|" + identityKey)
        || progress.attempts.some(x => x.anchorIdentityKey === key && x.identityKey === identityKey)
        || baseWork(item.track) === baseWork(anchor.track) || own.some(x => baseWork(x.track) === baseWork(item.track))) continue;
      const attempt = { anchorIdentityKey: key, identityKey, status: "started" };
      progress.attempts.push(attempt); mark();
      try {
        const canonical = await tidal.getTrack(id, item.track.artist + " " + item.track.title);
        assert.ok(canonical && scoreTidalIdentity(item.track, canonical).matched, "Current catalog identity mismatch.");
        assert.ok(normalizeArtistCredits(canonical.artist).includes(normalizeArtistCredits(item.query)[0]), "Canonical artist mismatch.");
        const track = { ...yearTrack(canonical), identityKey, tidalId: id };
        assert.ok(!anchorIsrc.has(track.isrc) && baseWork(track) !== baseWork(anchor.track) && !own.some(x => baseWork(x.track) === baseWork(track)), "Duplicate musical work.");
        const sourceTrack = await bp.findTrack(track, { allowVersionProxy: false });
        assert.ok(sourceTrack && matchBeatportVersionToTidal(track, sourceTrack, { allowVersionProxy: false }).relation === "exact", "Exact preview unavailable.");
        const streamed = await bp.fetchPreviewBuffer(sourceTrack, { maxBytes: 16 * 1024 * 1024 }), bytes = streamed.buffer;
        const sourceFile = path.join(directory, "audio", sha(bytes) + ".audio");
        if (!fs.existsSync(sourceFile)) fs.writeFileSync(sourceFile, bytes, { flag: "wx" });
        assert.equal(sha(fs.readFileSync(sourceFile)), sha(bytes));
        const source = freezeSonicSourceSnapshot({ track, sourceType: "beatport-preview", audioBytes: bytes, durationSeconds: probe(sourceFile), sourceTrack, allowVersionProxy: false });
        progress.references.push({ track, verification: { provider: "tidal", verified: true, identityKey, canonicalTrack: track }, source, sourceFile,
          selection: { kind: "same-artist", source: "artist-catalog-search", query: item.query, anchorIdentityKey: key } });
        bytes.fill(0); attempt.status = "frozen-exact-preview";
        console.log(JSON.stringify({ sourceFrozen: identityKey, anchor: anchor.track.title, ownArtistCount: own.length + 1 }));
      } catch (error) { attempt.status = "unavailable-or-unverified"; attempt.reason = /mismatch|Duplicate|Exact preview|thirty-second/.test(error.message) ? error.message : "Provider or source verification unavailable."; }
      mark();
    }
  }
  const groups = request.anchors.map(anchor => ({ anchor, references: progress.references.filter(x => x.selection.anchorIdentityKey === anchor.track.identityKey) }));
  if (groups.some(g => g.references.length !== 4 || g.references.filter(x => x.selection.kind === "same-artist").length !== (request.ownArtistCountsByAnchor?.[g.anchor.track.identityKey] ?? request.ownArtistCount))) throw Error("The bounded collection could not supply the declared exact references for each anchor. Preserve receipts; do not fill with unverified substitutes.");
  if (!fs.existsSync(path.join(directory, "plan.json"))) {
    const { buildCatalogReviewPlan } = require("../src/sonicCatalogReview");
    save(path.join(directory, "plan.json"), buildCatalogReviewPlan({ roundId: request.roundId, title: request.title, groups }));
  }
  console.log(JSON.stringify({ frozen: true, pairs: 8, providerQueries: progress.pages.length, verificationAttempts: progress.attempts.length }));
}
function cache(directory) {
  const planFile = path.join(directory, "plan.json"), plan = read(planFile);
  const { validateCatalogReviewPlan } = require("../src/sonicCatalogReview");
  withDb(db => validateCatalogReviewPlan(plan, { db, requirePrepared: false, cacheDirectory: CACHE }));
  const prefix = process.env.SONIC_ANALYSIS_ENV_ROOT || "/home/darth/micromamba-root/envs/rabbit-hole-mert2";
  let prepared = 0;
  for (const clip of Object.values(plan.clips)) {
    const file = path.join(CACHE, clip.clipId + ".wav");
    if (clip.wavSha256 && fs.existsSync(file) && sha(fs.readFileSync(file)) === clip.wavSha256) { validateWave(file, clip); prepared++; continue; }
    if (clip.sourceType === "verified-local-file") throw Error("The original verified anchor WAV is unavailable; do not regenerate it from a different source.");
    const sourceStat = fs.statSync(clip.sourceFile);
    assert.ok(sourceStat.isFile() && sourceStat.size > 0 && sourceStat.size <= 20 * 1024 * 1024, "Frozen preview exceeds the bounded cache input.");
    assert.equal(sha(fs.readFileSync(clip.sourceFile)), clip.sourceSha256);
    execFileSync("wsl.exe", ["-d", "Ubuntu", "--", prefix + "/bin/ffmpeg", "-v", "error", "-nostdin", "-i", wslPath(clip.sourceFile), "-ss", String(clip.start), "-t", String(clip.end - clip.start), "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-y", wslPath(file)], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
    validateWave(file, clip); assert.equal(sha(fs.readFileSync(clip.sourceFile)), clip.sourceSha256);
    clip.wavSha256 = sha(fs.readFileSync(file)); save(planFile, plan, false); prepared++;
  }
  withDb(db => validateCatalogReviewPlan(plan, { db, requirePrepared: true, cacheDirectory: CACHE }));
  console.log(JSON.stringify({ cached: true, uniqueClips: prepared, pairs: plan.count, published: false }));
}
function publish(directory) {
  const plan = read(path.join(directory, "plan.json"));
  const { validateCatalogReviewPlan } = require("../src/sonicCatalogReview"), { SonicBlindReview } = require("../src/sonicBlindReview");
  const result = withDb(db => { validateCatalogReviewPlan(plan, { db, requirePrepared: true, cacheDirectory: CACHE }); return new SonicBlindReview(db).create(plan); }, true);
  console.log(JSON.stringify({ published: true, batchId: result.batch.batchId, count: result.batch.count, completed: result.batch.completed,
    url: "http://127.0.0.1:3777/?sonicBlindBatch=" + encodeURIComponent(result.batch.batchId) }));
}
async function main(argv = process.argv.slice(2)) {
  const { stage, directory } = argsFor(argv);
  if (stage === "init") return init(directory);
  if (!fs.existsSync(path.join(directory, "request.json"))) throw Error("Initialize this private review first.");
  if (stage === "report") { const { SonicBlindReview } = require("../src/sonicBlindReview"); return console.log(JSON.stringify(withDb(db => new SonicBlindReview(db).report(read(path.join(directory, "plan.json")).batchId)), null, 2)); }
  const lockFile = path.join(ROOT, "data/sonic-blind-preparation.lock"), token = randomUUID();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), { flag: "wx" });
  try { if (stage === "collect") await collect(directory); else if (stage === "cache") cache(directory); else publish(directory); }
  finally { if (read(lockFile).token === token) fs.unlinkSync(lockFile); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, argsFor, privateDirectory, baseWork };
