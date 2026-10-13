"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createHash } = require("node:crypto"), { DatabaseSync } = require("node:sqlite");
const host = require("../scripts/sonic-catalog-verified-review-host"), { KIND, recipe } = require("../src/sonicCatalogVerifiedReview");
const ROOT = path.resolve(__dirname, ".."), PREFIX = "/api/recommendation-v2/sonic-review/blind", hash = bytes => createHash("sha256").update(bytes).digest("hex");
function wav(samples = 720000, channels = 1) {
  const bytes = Buffer.alloc(44 + samples * 2); bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40); return bytes;
}
function fixture(t) {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-fresh-host-")), data = path.join(artifactRoot, "data"), directory = path.join(data, "fresh"), cacheDirectory = path.join(directory, "blind-audio"); fs.mkdirSync(cacheDirectory, { recursive: true });
  const cleanups = []; t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); fs.rmSync(artifactRoot, { recursive: true, force: true }); });
  const mainDatabasePath = path.join(data, "main.sqlite"), main = new DatabaseSync(mainDatabasePath); main.exec("CREATE TABLE protected (value TEXT); INSERT INTO protected VALUES ('preserve main'); CREATE TABLE sonic_blind_review_batch (batch_id TEXT, private_plan_json TEXT); CREATE TABLE sonic_review_session_item (candidate_identity_key TEXT,review_json TEXT)"); main.close();
  const tracks = [1, 2, 3].map(n => ({ identityKey: "tidal:" + (810000 + n), tidalId: String(810000 + n), artist: "Artist " + n, title: "Track " + n, mixVersion: "Original Mix", album: "Album " + n, genre: "private sampling lane", isrc: "PRIVATEISRC" + n }));
  const clips = tracks.map((track, index) => { const clipId = hash("private clip " + index), bytes = wav(); fs.writeFileSync(path.join(cacheDirectory, clipId + ".wav"), bytes); return { clipId, start: 45.016327, end: 75.016327, sourceSha256: hash("private source " + index), sourceFile: path.join(directory, "private-" + index + ".audio"), sourceType: "beatport-preview", sourceSnapshotKey: "sonic-source-v1-" + hash("snapshot " + index), wavSha256: hash(bytes) }; });
  // The strict source/ranking validator is injected below; this small plan isolates
  // the host's publication, privacy and save behavior with the real scope recipe.
  const plan = { version: 7, kind: KIND, batchId: "blind:fixture-verified", planKey: hash("private plan"), title: "Fresh catalog listening review", models: ["mert-30s"], recipe: recipe("two-genre"), count: 2, anchorCount: 1, requestCount: 4,
    groups: [{ sessionId: "sonic-review:fixture-fresh", anchor: tracks[0], anchorClip: clips[0].clipId, candidates: tracks.slice(1).map((track, index) => ({ track, clipId: clips[index + 1].clipId, nominations: [{ analyzer: "mert-30s", rank: index + 1 }], retrieval: { similarity: .9876, sourceFile: "private retrieval evidence" } })) }], clips: Object.fromEntries(clips.map(c => [c.clipId, c])) };
  const savePlan = () => fs.writeFileSync(path.join(directory, "review-plan.json"), JSON.stringify(plan)); savePlan();
  let validated = 0;
  const options = { directory, artifactRoot, projectRoot: ROOT, mainDatabasePath, validatePlan(actual, { db, requirePrepared, cacheDirectory: cache }) { validated++; assert.deepEqual(actual, plan); assert.equal(requirePrepared, true); assert.equal(cache, cacheDirectory); assert.equal(db.prepare("PRAGMA query_only").get().query_only, 1); assert.throws(() => db.exec("INSERT INTO protected VALUES ('forbidden')"), /readonly|read.only/i); } };
  return { ...options, options, plan, tracks, clips, cacheDirectory, savePlan, cleanups, mainBefore: hash(fs.readFileSync(mainDatabasePath)), validated: () => validated, db() { return new DatabaseSync(path.join(directory, "review.sqlite"), { readOnly: true }); } };
}
async function running(t, fixture) { host.prepareReview(fixture.options); const instance = await host.startHost({ ...fixture.options, port: 0 }); fixture.cleanups.push(() => instance.close()); return { ...instance, base: new URL(instance.url).origin }; }
function privateFree(value, f) { const text = JSON.stringify(value); assert.ok(!/"(?:retrieval|nominations|similarity)"\s*:/.test(text)); for (const secret of ["identityKey", "tidalId", "tidal:", "sourceSha256", "sourceSnapshotKey", "sourceFile", "private sampling", f.directory, ...f.clips.map(c => c.sourceSha256), ...f.tracks.map(t => t.isrc)]) assert.ok(!text.includes(secret), secret); }
async function post(base, value, extra = {}) { return fetch(base + PREFIX + "/save", { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(value) }); }
const decision = (f, index, choice, listened = true) => ({ batchId: f.plan.batchId, sessionId: f.plan.groups[0].sessionId, index, decision: choice, listened, note: "" });

test("CLI accepts only explicit private preparation/localhost serving arguments", () => {
  assert.equal(host.argumentsFor(["serve", "--directory", "data/example"]).port, 3791);
  assert.equal(host.argumentsFor(["serve", "--directory", "data/example", "--port", "3790"]).port, 3790);
  for (const args of [["serve"], ["publish", "--directory", "data/example"], ["prepare", "--directory", "data/example", "--port", "3789"], ["serve", "--directory"], ["serve", "--directory", "data/example", "--port", "0"], ["serve", "--directory", "data/example", "--port", "65536"], ["serve", "--directory", "data/example", "--directory", "data/other"], ["serve", "--directory", "data/example", "--host", "0.0.0.0"]]) assert.throws(() => host.argumentsFor(args));
});
test("preparation publishes only opaque musical rows in the isolated DB and is idempotent", t => {
  const f = fixture(t), result = host.prepareReview(f.options); assert.deepEqual(result, { prepared: true, reused: false, batchId: f.plan.batchId, count: 2 });
  const db = f.db(); try { const sessions = db.prepare("SELECT * FROM sonic_review_session").all(), items = db.prepare("SELECT * FROM sonic_review_session_item").all(); assert.equal(sessions.length, 1); assert.equal(sessions[0].status, "READY"); assert.equal(sessions[0].completed_count, 0); assert.equal(sessions[0].current_index, 0); assert.equal(sessions[0].queued_count, 0); assert.match(sessions[0].anchor_identity_key, /^blind-reference:[a-f0-9]{64}$/); privateFree(JSON.parse(sessions[0].anchor_json), f);
    for (const item of items) { assert.equal(item.status, "PENDING"); for (const key of ["decision", "confidence", "review_json", "queued_at", "error"]) assert.equal(item[key], null); assert.match(item.candidate_identity_key, /^blind-reference:/); privateFree(JSON.parse(item.candidate_json), f); }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sonic_review_session_audit").get().n, 1);
  } finally { db.close(); }
  assert.equal(host.prepareReview(f.options).reused, true); const again = f.db(); assert.equal(again.prepare("SELECT COUNT(*) n FROM sonic_review_session_audit").get().n, 1); again.close(); assert.equal(hash(fs.readFileSync(f.mainDatabasePath)), f.mainBefore); assert.equal(f.validated(), 2);
});
test("failed freshness or changed WAV blocks publication before private review rows exist", t => {
  const f = fixture(t); assert.throws(() => host.prepareReview({ ...f.options, validatePlan() { throw Error("freshness failed"); } }), /freshness failed/); assert.equal(fs.existsSync(path.join(f.directory, "review.sqlite")), false);
  const file = path.join(f.cacheDirectory, f.clips[0].clipId + ".wav"), bytes = fs.readFileSync(file); bytes[50] ^= 1; fs.writeFileSync(file, bytes); assert.throws(() => host.prepareReview(f.options), /audio changed/); assert.equal(fs.existsSync(path.join(f.directory, "review.sqlite")), false); assert.equal(hash(fs.readFileSync(f.mainDatabasePath)), f.mainBefore);
});
test("audio validator enforces PCM mono24k16bit complete30s and one-sample precision", t => {
  const f = fixture(t), file = path.join(f.cacheDirectory, f.clips[0].clipId + ".wav"), clip = { ...f.clips[0] };
  for (const samples of [719999, 720000, 720001]) { const bytes = wav(samples); fs.writeFileSync(file, bytes); clip.wavSha256 = hash(bytes); host.checkWave(file, clip); }
  for (const bytes of [wav(719998), wav(720002), wav(720000, 2), wav().subarray(0, 100)]) { fs.writeFileSync(file, bytes); clip.wavSha256 = hash(bytes); assert.throws(() => host.checkWave(file, clip)); }
});
test("private paths and existing ownership records fail closed", t => {
  const f = fixture(t); assert.throws(() => host.privateDirectory(path.join(f.artifactRoot, "other"), f.artifactRoot)); assert.throws(() => host.safeFile(f.directory, f.mainDatabasePath));
  const link = path.join(f.directory, "escape"); fs.symlinkSync(path.dirname(f.mainDatabasePath), link, "junction"); assert.throws(() => host.safeFile(f.directory, path.join(link, "main.sqlite")), /links/);
  fs.writeFileSync(path.join(f.directory, "host-runtime.json"), "{}\n"); assert.throws(() => host.prepareReview(f.options), /owned listening host/); assert.equal(fs.existsSync(path.join(f.directory, "review.sqlite")), false);
});
test("initial and POST DTOs hide model/source identities and normalize media offsets", async t => {
  const f = fixture(t), h = await running(t, f), response = await fetch(h.base + PREFIX + "?batchId=" + encodeURIComponent(f.plan.batchId)), initial = await response.json(); assert.equal(response.status, 200); privateFree(initial, f); assert.equal(initial.batch.count, 2); assert.equal(initial.batch.completed, 0); assert.deepEqual(initial.batch.groups[0].anchorAudio.start, 0); assert.equal(initial.batch.groups[0].anchorAudio.end, 30);
  const saved = await (await post(h.base, decision(f, 0, "KEEP"))).json(); privateFree(saved, f); assert.equal(saved.batch.completed, 1); assert.equal(saved.batch.groups[0].items[0].review.reviewer, "human"); assert.equal(saved.batch.globalRatingsChanged, false); assert.equal(hash(fs.readFileSync(f.mainDatabasePath)), f.mainBefore);
});
test("save gates and unknown routes do not create judgments; valid repeat/revision preserves audit semantics", async t => {
  const f = fixture(t), h = await running(t, f); assert.equal((await post(h.base, decision(f, 0, "KEEP", false))).status, 400); assert.equal((await post(h.base, { ...decision(f, 0, "KEEP"), batchId: "blind:other" })).status, 400); assert.equal((await post(h.base, { ...decision(f, 0, "KEEP"), note: "x".repeat(2001) })).status, 400); assert.equal((await post(h.base, decision(f, 0, "KEEP"), { origin: "https://unrelated.example" })).status, 400); assert.equal((await fetch(h.base + "/api/recommendation-v2/sonic-review/session")).status, 404); assert.equal((await fetch(h.base + "/api/roon/queue", { method: "POST" })).status, 404);
  assert.equal((await (await fetch(h.base + PREFIX)).json()).batch.completed, 0);
  for (const value of [decision(f, 0, "KEEP"), decision(f, 0, "KEEP"), decision(f, 0, "SKIP")]) assert.equal((await post(h.base, value)).status, 200);
  const db = f.db(); try { assert.equal(db.prepare("SELECT COUNT(*) n FROM sonic_review_session_audit WHERE event_type='BLIND_LISTENING_SAVED'").get().n, 2); assert.equal(db.prepare("SELECT decision FROM sonic_review_session_item WHERE item_index=0").get().decision, "SKIP"); } finally { db.close(); }
  assert.equal(hash(fs.readFileSync(f.mainDatabasePath)), f.mainBefore);
});
test("report withholds the single-model identity until all human decisions, preserving uncertainty", async t => {
  const f = fixture(t), h = await running(t, f), get = async () => (await fetch(h.base + PREFIX + "/report")).json(); const first = await get(); assert.equal(first.ready, false); assert.ok(!JSON.stringify(first).includes("mert-30s")); await post(h.base, decision(f, 0, "KEEP")); assert.equal((await get()).ready, false); await post(h.base, decision(f, 1, "UNSURE", false)); const complete = await get(); assert.equal(complete.ready, true); assert.equal(complete.analyzer, "mert-30s"); assert.equal(complete.samplingScope, "two-genre"); assert.equal(complete.missingSlots, 10); assert.deepEqual(complete.decisions, { KEEP: 1, WRONG_LANE: 0, SKIP: 0, UNSURE: 1 }); assert.equal(complete.productionPromotionAllowed, false); privateFree(complete, f);
});
test("allowlisted prepared WAVs support HEAD/ranges and reject changed bytes/foreign batches", async t => {
  const f = fixture(t), h = await running(t, f), url = h.base + PREFIX + "/audio?batchId=" + encodeURIComponent(f.plan.batchId) + "&clipId=" + f.clips[0].clipId;
  const head = await fetch(url, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(Number(head.headers.get("content-length")), wav().length); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await fetch(url, { headers: { range: "bytes=0-43" } }); assert.equal(range.status, 206); assert.equal(range.headers.get("content-range"), "bytes 0-43/" + wav().length); assert.deepEqual(Buffer.from(await range.arrayBuffer()), wav().subarray(0, 44));
  assert.equal((await fetch(url, { headers: { range: "bytes=99999999-" } })).status, 416); assert.equal((await fetch(url.replace(encodeURIComponent(f.plan.batchId), "blind%3Aother"))).status, 404); assert.equal((await fetch(h.base + PREFIX + "/audio?batchId=" + encodeURIComponent(f.plan.batchId) + "&clipId=../../secret")).status, 404);
  const file = path.join(f.cacheDirectory, f.clips[0].clipId + ".wav"), bytes = fs.readFileSync(file); bytes[50] ^= 1; fs.writeFileSync(file, bytes); assert.equal((await fetch(url)).status, 503);
});
test("host serves exact three assets and a no-player/no-autoplay shell with owned lifecycle", async t => {
  const f = fixture(t), h = await running(t, f), runtime = JSON.parse(fs.readFileSync(path.join(f.directory, "host-runtime.json"))); assert.equal(runtime.pid, process.pid); assert.equal(runtime.host, "127.0.0.1");
  const html = await (await fetch(h.base)).text(); assert.ok(html.includes('id="sonicReviewApp"') && html.includes('class="shell"')); assert.ok(!/app\.js|autoplay|\/api\/roon/.test(html));
  for (const file of ["styles.css", "sonicBlindReview.css", "sonicBlindReview.js"]) { const bytes = Buffer.from(await (await fetch(h.base + "/" + file)).arrayBuffer()); assert.equal(hash(bytes), hash(fs.readFileSync(path.join(ROOT, "public", file)))); }
  assert.equal((await fetch(h.base + "/app.js")).status, 404); await h.close(); assert.equal(fs.existsSync(path.join(f.directory, "host-runtime.json")), false);
});
test("changed publication/plan binding is rejected without reopening or repairing private rows", t => {
  const f = fixture(t); host.prepareReview(f.options); const database = path.join(f.directory, "review.sqlite"), before = hash(fs.readFileSync(database)); f.plan.title = "Changed frozen plan"; f.savePlan(); assert.throws(() => host.openReview(f.options)); assert.equal(hash(fs.readFileSync(database)), before);
});
