"use strict";

// A private, localhost-only listening surface. This does not import the main
// server, construct providers/workers, or publish into the runtime database.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const assert = require("node:assert/strict"), { createHash, randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { SonicBlindReview } = require("../src/sonicBlindReview");
const { createSonicReviewSessionService } = require("../src/sonicReviewSessionService");
const { musicalNames, opaqueListeningIdentity } = require("../src/sonicCatalogReview");
const { serveBlindAudio } = require("../src/sonicBlindAudio");
const fresh = require("../src/sonicCatalogVerifiedReview");
const ROOT = path.resolve(__dirname, ".."), PREFIX = "/api/recommendation-v2/sonic-review/blind";
const STATIC = Object.freeze({ "/styles.css": "public/styles.css", "/sonicBlindReview.css": "public/sonicBlindReview.css", "/sonicBlindReview.js": "public/sonicBlindReview.js" });
const HOST_CODE = Object.freeze(["scripts/sonic-catalog-verified-review-host.js", "src/sonicBlindReview.js", "src/sonicBlindAudio.js", "src/sonicReviewSessionService.js", ...Object.values(STATIC)]);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file));
const writeNew = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
function below(root, target) { const relative = path.relative(root, target); return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); }
function safeFile(root, target, { exists = true, maximum = 16 * 1024 * 1024 } = {}) {
  const base = fs.realpathSync(root), absolute = path.resolve(target);
  assert.ok(below(base, absolute), "The listening file escaped its approved directory.");
  let current = base;
  for (const part of path.relative(base, absolute).split(path.sep)) {
    current = path.join(current, part);
    try { const stat = fs.lstatSync(current); assert.ok(!stat.isSymbolicLink(), "Listening paths cannot use symbolic links."); assert.ok(below(base, fs.realpathSync(current)), "The listening file escaped its approved directory."); }
    catch (error) { if (!exists && error.code === "ENOENT") continue; throw error; }
  }
  if (exists) { const stat = fs.statSync(absolute); assert.ok(stat.isFile() && stat.size > 0 && stat.size <= maximum, "Invalid bounded listening file."); }
  return absolute;
}
function privateDirectory(directory, artifactRoot = ROOT) {
  const base = fs.realpathSync(path.join(artifactRoot, "data")), target = path.resolve(directory);
  assert.ok(below(base, target), "Choose an existing private experiment directory under data.");
  let current = base;
  for (const part of path.relative(base, target).split(path.sep)) { current = path.join(current, part); assert.ok(fs.lstatSync(current).isDirectory() && !fs.lstatSync(current).isSymbolicLink(), "The private experiment directory cannot use links."); }
  assert.equal(fs.realpathSync(target), target); return target;
}
function argumentsFor(argv) {
  const [stage, ...args] = argv; assert.ok(["prepare", "serve"].includes(stage), "Choose prepare or serve.");
  const result = { stage, port: 3791 }, seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]; assert.ok(["--directory", "--port"].includes(key) && !seen.has(key), "Unknown or repeated listening-host option."); seen.add(key);
    const value = args[++index]; assert.ok(value && !value.startsWith("--"), "A listening-host option needs a value.");
    if (key === "--directory") result.directory = path.resolve(ROOT, value);
    else { assert.equal(stage, "serve", "The port belongs to serve."); result.port = Number(value); assert.ok(Number.isInteger(result.port) && result.port >= 1024 && result.port <= 65535, "Choose an unprivileged localhost port."); }
  }
  assert.ok(result.directory, "Declare the private experiment directory."); return result;
}
function hostCode(projectRoot = ROOT) { return { files: HOST_CODE.map(file => ({ path: file, sha256: sha(fs.readFileSync(safeFile(projectRoot, path.join(projectRoot, file), { maximum: 8 * 1024 * 1024 }))) })) }; }
function checkWave(file, clip) {
  const bytes = fs.readFileSync(file); assert.equal(sha(bytes), clip.wavSha256, "Prepared listening audio changed.");
  assert.ok(bytes.length >= 44 && bytes.length <= 2 * 1024 * 1024 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE");
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length); let format = null, samples = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8; assert.ok(start + size <= bytes.length);
    if (id === "fmt ") { assert.ok(size >= 16 && !format); format = [bytes.readUInt16LE(start), bytes.readUInt16LE(start + 2), bytes.readUInt32LE(start + 4), bytes.readUInt16LE(start + 14)]; }
    if (id === "data") { assert.equal(size % 2, 0); samples += size / 2; }
    offset = start + size + size % 2;
  }
  assert.deepEqual(format, [1, 1, 24000, 16]); assert.ok(Math.abs(samples - 720000) <= 1 && Math.abs(clip.end - clip.start - 30) <= .000002, "Prepare the exact thirty-second excerpt.");
}
function loadInputs(directory, { artifactRoot = ROOT, projectRoot = ROOT } = {}) {
  directory = privateDirectory(directory, artifactRoot);
  const planFile = safeFile(directory, path.join(directory, "review-plan.json")), planBytes = fs.readFileSync(planFile), plan = JSON.parse(planBytes);
  assert.equal(plan.version, 7); assert.equal(plan.kind, fresh.KIND); assert.deepEqual(plan.models, ["mert-30s"]);
  assert.ok(Array.isArray(plan.groups) && plan.groups.length > 0 && plan.groups.length <= 4 && plan.count > 0 && plan.count <= 12);
  const cacheDirectory = path.join(directory, "blind-audio"); assert.ok(fs.lstatSync(cacheDirectory).isDirectory() && !fs.lstatSync(cacheDirectory).isSymbolicLink());
  for (const [id, clip] of Object.entries(plan.clips || {})) { assert.ok(/^[a-f0-9]{64}$/.test(id) && clip.clipId === id); checkWave(safeFile(cacheDirectory, path.join(cacheDirectory, id + ".wav"), { maximum: 2 * 1024 * 1024 }), clip); }
  return { directory, planFile, planBytes, plan, cacheDirectory, artifactRoot, projectRoot };
}
function validateAgainstMain(context, { mainDatabasePath = path.join(ROOT, "data/rabbit-hole-memory.sqlite"), validatePlan = fresh.validateVerifiedCatalogReviewPlan } = {}) {
  const main = new DatabaseSync(mainDatabasePath, { readOnly: true }); main.exec("PRAGMA query_only=ON;BEGIN");
  try { validatePlan(context.plan, { db: main, requirePrepared: true, cacheDirectory: context.cacheDirectory, artifactRoot: context.artifactRoot }); }
  finally { main.exec("ROLLBACK"); main.close(); }
}
function makeService(db, plan) {
  const service = new SonicBlindReview(db);
  service.plan = id => !id || id === plan.batchId ? clone(plan) : null;
  service.get = id => !id || id === plan.batchId ? fresh.getVerifiedCatalogReviewSnapshot(plan, db) : { ok: true, batch: null };
  service.report = id => !id || id === plan.batchId ? fresh.completedVerifiedCatalogReport(plan, service.get(id).batch) : { ok: true, ready: false };
  return service;
}
function assertPrivateRows(db, plan) {
  const stored = db.prepare("SELECT batch_id,plan_key,private_plan_json FROM sonic_blind_review_batch").all(); assert.equal(stored.length, 1); assert.equal(stored[0].batch_id, plan.batchId); assert.equal(stored[0].plan_key, plan.planKey); assert.equal(stored[0].private_plan_json, JSON.stringify(plan));
  const sessions = db.prepare("SELECT session_id,anchor_identity_key,anchor_json,model,queue_policy,profile_policy FROM sonic_review_session ORDER BY session_id").all(); assert.equal(sessions.length, plan.groups.length);
  for (const group of plan.groups) {
    const row = sessions.find(s => s.session_id === group.sessionId); assert.ok(row); assert.equal(row.anchor_identity_key, opaqueListeningIdentity(plan.batchId, group.sessionId, "anchor")); assert.equal(row.anchor_json, JSON.stringify(musicalNames(group.anchor))); assert.equal(row.model, "blind-listening"); assert.equal(row.queue_policy, "NEVER"); assert.equal(row.profile_policy, "LISTENING_ONLY");
    const items = db.prepare("SELECT item_index,candidate_identity_key,candidate_json FROM sonic_review_session_item WHERE session_id=? ORDER BY item_index").all(group.sessionId); assert.equal(items.length, group.candidates.length);
    for (const [index, item] of items.entries()) { assert.equal(item.item_index, index); assert.equal(item.candidate_identity_key, opaqueListeningIdentity(plan.batchId, group.sessionId, "candidate", index)); assert.equal(item.candidate_json, JSON.stringify(musicalNames(group.candidates[index].track))); }
  }
}
function prepareReview({ directory, artifactRoot = ROOT, projectRoot = ROOT, mainDatabasePath, validatePlan } = {}) {
  const context = loadInputs(directory, { artifactRoot, projectRoot }); validateAgainstMain(context, { mainDatabasePath, validatePlan });
  assert.ok(!fs.existsSync(path.join(context.directory, "host-runtime.json")), "Close the owned listening host before preparation.");
  const databaseFile = safeFile(context.directory, path.join(context.directory, "review.sqlite"), { exists: false }), publicationFile = path.join(context.directory, "publication.json");
  const reused = fs.existsSync(databaseFile); assert.equal(reused, fs.existsSync(publicationFile), "Preserve incomplete private publication for inspection.");
  const db = new DatabaseSync(databaseFile); db.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000");
  try {
    if (reused) { const receipt = read(safeFile(context.directory, publicationFile)); assert.equal(receipt.reviewPlanSha256, sha(context.planBytes)); assert.deepEqual(receipt.hostCode, hostCode(projectRoot)); assertPrivateRows(db, context.plan); return { prepared: true, reused: true, batchId: context.plan.batchId, count: context.plan.count }; }
    createSonicReviewSessionService({ db }); new SonicBlindReview(db); const now = new Date().toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const group of context.plan.groups) {
        db.prepare(`INSERT INTO sonic_review_session (session_id,anchor_identity_key,anchor_json,requested_count,candidate_count,status,review_policy,queue_policy,profile_policy,novelty_policy,model,model_version,diagnostics_json,created_at,updated_at)
          VALUES (?,?,?,?,?,'READY','HUMAN_CONFIRM_EACH','NEVER','LISTENING_ONLY','ALLOW_KNOWN','blind-listening','1',?,?,?)`).run(group.sessionId, opaqueListeningIdentity(context.plan.batchId, group.sessionId, "anchor"), JSON.stringify(musicalNames(group.anchor)), group.candidates.length, group.candidates.length, JSON.stringify({ blind: true, batchId: context.plan.batchId, kind: fresh.KIND }), now, now);
        for (const [index, candidate] of group.candidates.entries()) db.prepare("INSERT INTO sonic_review_session_item (session_id,item_index,candidate_identity_key,candidate_json,relation_json,status,created_at,updated_at) VALUES (?,?,?,?,'{}','PENDING',?,?)").run(group.sessionId, index, opaqueListeningIdentity(context.plan.batchId, group.sessionId, "candidate", index), JSON.stringify(musicalNames(candidate.track)), now, now);
        db.prepare("INSERT INTO sonic_review_session_audit (session_id,event_type,source,assistant,new_value,created_at) VALUES (?,'BLIND_BATCH_PREPARED','LOCAL','',?,?)").run(group.sessionId, JSON.stringify({ batchId: context.plan.batchId }), now);
      }
      db.prepare("INSERT INTO sonic_blind_review_batch VALUES (?,?,?,?)").run(context.plan.batchId, context.plan.planKey, JSON.stringify(context.plan), now); db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    assertPrivateRows(db, context.plan);
    writeNew(publicationFile, { version: 1, kind: fresh.KIND, preparedAt: now, batchId: context.plan.batchId, planKey: context.plan.planKey, count: context.plan.count, reviewPlanSha256: sha(context.planBytes), hostCode: hostCode(projectRoot), databaseFile: "review.sqlite", cacheDirectory: "blind-audio", mainDatabaseReadOnly: true, mainDatabaseRowsInserted: 0, productionApplied: false });
    return { prepared: true, reused: false, batchId: context.plan.batchId, count: context.plan.count };
  } finally { db.close(); }
}
function openReview({ directory, artifactRoot = ROOT, projectRoot = ROOT, mainDatabasePath, validatePlan } = {}) {
  const context = loadInputs(directory, { artifactRoot, projectRoot }); validateAgainstMain(context, { mainDatabasePath, validatePlan });
  const receipt = read(safeFile(context.directory, path.join(context.directory, "publication.json"))); assert.equal(receipt.reviewPlanSha256, sha(context.planBytes)); assert.deepEqual(receipt.hostCode, hostCode(projectRoot)); assert.equal(receipt.mainDatabaseRowsInserted, 0);
  const db = new DatabaseSync(safeFile(context.directory, path.join(context.directory, "review.sqlite"))); db.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000");
  try { assertPrivateRows(db, context.plan); return { ...context, receipt, db, service: makeService(db, context.plan), close: () => db.close() }; } catch (error) { db.close(); throw error; }
}
function shell() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Blind listening</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/sonicBlindReview.css"></head><body><main class="shell"><div id="sonicReviewApp"></div></main><script>
window.setActiveView=function(){};window.renderSonicReview=function(){document.getElementById("sonicReviewApp").innerHTML='<section class="panel"><h2>Blind listening</h2><p>Your listening progress is saved. Global ratings and discovery ranking stay unchanged.</p><button type="button" data-sonic-blind-open>Return to listening</button></section>';};
new MutationObserver(function(){document.querySelectorAll('#sonicReviewApp p[role="status"]').forEach(function(p){if(p.textContent.indexOf('Listening complete. Your judgments are saved for the model comparison;')===0)p.textContent='Listening complete. Your judgments are saved for this small listening test; no model has been promoted.';});}).observe(document.getElementById('sonicReviewApp'),{childList:true,subtree:true});
window.renderSonicReview();</script><script src="/sonicBlindReview.js"></script></body></html>`;
}
function send(res, status, value) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(value)); }
async function body(req) { assert.ok(/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""), "Use JSON for a listening decision."); let length = 0, chunks = []; for await (const chunk of req) { length += chunk.length; assert.ok(length <= 16384, "Listening request is too large."); chunks.push(chunk); } const value = JSON.parse(Buffer.concat(chunks)); assert.ok(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => ["batchId", "sessionId", "index", "decision", "listened", "note"].includes(key)), "Invalid listening request."); return value; }
function createHostHandler(context) {
  return async (req, res) => {
    try {
      assert.ok(/^(?:127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || ""), "Localhost listening only.");
      const url = new URL(req.url, "http://" + req.headers.host), pathname = url.pathname;
      if (req.method === "GET" && pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }); return res.end(shell()); }
      if (["GET", "HEAD"].includes(req.method) && Object.hasOwn(STATIC, pathname)) {
        const file = safeFile(context.projectRoot, path.join(context.projectRoot, STATIC[pathname]), { maximum: 8 * 1024 * 1024 }), bytes = fs.readFileSync(file), pin = context.receipt.hostCode.files.find(row => row.path === STATIC[pathname]); assert.equal(sha(bytes), pin?.sha256);
        res.writeHead(200, { "Content-Type": pathname.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", "Content-Length": bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); return res.end(req.method === "HEAD" ? undefined : bytes);
      }
      const id = url.searchParams.get("batchId");
      if (["GET", "HEAD"].includes(req.method) && pathname === PREFIX + "/audio") {
        const clipId = url.searchParams.get("clipId"), clip = context.plan.clips[clipId]; if (id !== context.plan.batchId || !/^[a-f0-9]{64}$/.test(clipId || "") || !clip) { res.writeHead(404); return res.end(); }
        try { checkWave(safeFile(context.cacheDirectory, path.join(context.cacheDirectory, clipId + ".wav"), { maximum: 2 * 1024 * 1024 }), clip); } catch { return send(res, 503, { ok: false, error: "Listening excerpt unavailable." }); }
        return await serveBlindAudio(req, res, context.service, url, context.cacheDirectory);
      }
      if (req.method === "GET" && pathname === PREFIX) return send(res, 200, context.service.get(id || ""));
      if (req.method === "GET" && pathname === PREFIX + "/report") return send(res, 200, context.service.report(id || ""));
      if (req.method === "POST" && pathname === PREFIX + "/save") {
        if (req.headers.origin) assert.equal(req.headers.origin, "http://" + req.headers.host, "Use this localhost listening page.");
        return send(res, 200, context.service.save(await body(req)));
      }
      return send(res, 404, { ok: false, error: "Listening route unavailable." });
    } catch (error) { if (!res.headersSent) send(res, 400, { ok: false, error: /Listen to both excerpts|Choose a valid listening decision|This listening item|batch and review session/.test(error.message) ? error.message : "Listening request could not be completed." }); else res.destroy(); }
  };
}
async function startHost(options) {
  const context = openReview(options), runtimeFile = path.join(context.directory, "host-runtime.json"), token = randomUUID(), server = http.createServer(createHostHandler(context));
  let recorded = false, closed = false;
  async function close() { if (closed) return; closed = true; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); context.close(); if (recorded) { const row = read(runtimeFile); assert.equal(row.token, token); assert.equal(row.pid, process.pid); fs.unlinkSync(runtimeFile); } }
  try {
    assert.ok(!fs.existsSync(runtimeFile), "Preserve an existing listening-host owner record.");
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 3791, "127.0.0.1", resolve); });
    const port = server.address().port; writeNew(runtimeFile, { version: 1, pid: process.pid, token, startedAt: new Date().toISOString(), host: "127.0.0.1", port, batchId: context.plan.batchId, planKey: context.plan.planKey, reviewPlanSha256: sha(context.planBytes), productionApplied: false }); recorded = true;
    return { server, context, close, url: `http://127.0.0.1:${port}/?sonicBlindBatch=${encodeURIComponent(context.plan.batchId)}` };
  } catch (error) { await close(); throw error; }
}
async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  if (options.stage === "prepare") { console.log(JSON.stringify(prepareReview(options))); return; }
  const host = await startHost(options); console.log(JSON.stringify({ listeningHost: true, url: host.url, count: host.context.plan.count, productionApplied: false }));
  let stopping = false; const stop = async () => { if (stopping) return; stopping = true; try { await host.close(); } catch { process.exitCode = 1; } };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
if (require.main === module) main().catch(() => { console.error("The private listening host could not prepare or start. Inspect its approved artifacts and ownership record."); process.exitCode = 1; });
module.exports = { argumentsFor, safeFile, privateDirectory, checkWave, loadInputs, validateAgainstMain, makeService, prepareReview, openReview, shell, createHostHandler, startHost, hostCode, main };
