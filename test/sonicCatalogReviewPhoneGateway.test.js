"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createHash, randomUUID } = require("node:crypto"), gateway = require("../scripts/sonic-catalog-review-phone-gateway");
const ROOT = path.resolve(__dirname, ".."), SCRIPT = "scripts/sonic-catalog-review-phone-gateway.js", KEY = "1".repeat(64), CLIP = "2".repeat(64), OTHER = "3".repeat(64);
const BATCH = "blind:00000000-0000-4000-8000-000000000001";
const sha = bytes => createHash("sha256").update(bytes).digest("hex"), cookie = gateway.cookieFor(BATCH) + "=" + KEY;
const batchQuery = "batchId=" + encodeURIComponent(BATCH), reviewPath = "/?sonicBlindBatch=" + encodeURIComponent(BATCH);
async function listening(server) { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return server.address().port; }
async function close(server) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
async function fixture(t) {
  const seen = [], audio = Buffer.from("RIFF test listening bytes");
  const upstream = http.createServer((req, res) => {
    let chunks = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === reviewPath) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "upstream-secret=value", "access-control-allow-origin": "*" }); return res.end('<!doctype html><html><head><title>Blind listening</title></head><body><script src="/sonicBlindReview.js"></script></body></html>'); }
      if (req.url.includes("/audio")) {
        const range = req.headers.range, bytes = range ? audio.subarray(0, 4) : audio;
        res.writeHead(range ? 206 : 200, { "content-type": "audio/wav", "content-length": bytes.length, "accept-ranges": "bytes", ...(range ? { "content-range": "bytes 0-3/" + audio.length } : {}) }); return res.end(req.method === "HEAD" ? undefined : bytes);
      }
      if (req.url.startsWith(gateway.PREFIX + "/save")) { res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream-secret=value", "access-control-allow-origin": "*" }); return res.end('{"ok":true,"saved":true}'); }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  const upstreamPort = await listening(upstream); let handler;
  const server = http.createServer((req, res) => handler(req, res)), port = await listening(server), origin = "http://127.0.0.1:" + port;
  handler = gateway.createGatewayHandler({ batchId: BATCH, upstream: { hostname: "127.0.0.1", port: 3791 }, clipIds: new Set([CLIP]), host: "127.0.0.1", port, accessKey: KEY }, { request(options, callback) { assert.equal(options.hostname, "127.0.0.1"); assert.equal(options.port, 3791); return http.request({ ...options, port: upstreamPort }, callback); } });
  t.after(async () => { await close(server); await close(upstream); });
  function request(target, options = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: "127.0.0.1", port, path: target, method: options.method || "GET", headers: { host: "127.0.0.1:" + port, ...(options.auth === false ? {} : { cookie }), ...options.headers } }, incoming => {
        const chunks = []; incoming.on("data", chunk => chunks.push(chunk)); incoming.once("error", reject); incoming.once("end", () => resolve({ status: incoming.statusCode, headers: incoming.headers, bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString() }));
      }); outgoing.once("error", reject); for (const chunk of options.chunks || []) outgoing.write(chunk); outgoing.end(options.body);
    });
  }
  return { request, seen, origin, audio };
}
const saveBody = () => JSON.stringify({ batchId: BATCH, sessionId: "sonic-review:fake", index: 0, decision: "KEEP", listened: true, note: "fixture only" });

test("CLI requires an explicit IPv4 and separate port, with no wildcard or upstream option", () => {
  const actual = gateway.argumentsFor(["serve", "--directory", "data/fresh", "--host", "192.168.50.119"]); assert.equal(actual.host, "192.168.50.119"); assert.equal(actual.port, 3792);
  for (const args of [["serve"], ["serve", "--directory", "data/fresh"], ["serve", "--directory", "data/fresh", "--host", "0.0.0.0"], ["serve", "--directory", "data/fresh", "--host", "::"], ["serve", "--directory", "data/fresh", "--host", "192.168.50.119", "--port", "3777"], ["serve", "--directory", "data/fresh", "--host", "192.168.50.119", "--upstream", "https://example.com"], ["serve", "--directory", "data/fresh", "--host", "192.168.50.119", "--host", "127.0.0.1"]]) assert.throws(() => gateway.argumentsFor(args));
});
test("access bootstrap returns the derived review HTML directly with a strict cookie and removes its key before frontend code", async t => {
  const f = await fixture(t);
  for (const target of ["/?access=" + KEY, reviewPath + "&access=" + KEY]) {
    const boot = await f.request(target, { auth: false }); assert.equal(boot.status, 200); assert.equal(boot.headers.location, undefined); assert.equal(boot.headers["set-cookie"][0], cookie + "; HttpOnly; SameSite=Strict; Path=/"); assert.equal(boot.headers["referrer-policy"], "no-referrer"); assert.equal(boot.headers["access-control-allow-origin"], undefined); assert.ok(!boot.text.includes(KEY)); assert.ok(boot.text.includes('history.replaceState(null,"",' + JSON.stringify(reviewPath) + ')')); assert.ok(boot.text.indexOf("history.replaceState") < boot.text.indexOf('/sonicBlindReview.js')); assert.equal(Number(boot.headers["content-length"]), boot.bytes.length);
  }
  assert.equal(f.seen.length, 2); for (const row of f.seen) { assert.equal(row.path, reviewPath); assert.equal(row.headers.host, "127.0.0.1:3791"); assert.equal(row.headers.cookie, undefined); }
  for (const target of [reviewPath, "/styles.css", gateway.PREFIX + "?" + batchQuery, gateway.PREFIX + "/audio?" + batchQuery + "&clipId=" + CLIP]) assert.equal((await f.request(target, { auth: false })).status, 401);
  assert.equal((await f.request("/?access=" + OTHER, { auth: false })).status, 401); assert.equal((await f.request(reviewPath, { headers: { cookie: cookie + "; " + cookie } })).status, 401); assert.equal(f.seen.length, 2);
  assert.equal((await f.request(reviewPath)).status, 200); assert.equal(f.seen.length, 3);
});
test("Host is exact and all destinations, batch queries, methods and clip IDs are scoped", async t => {
  const f = await fixture(t);
  assert.equal((await f.request(reviewPath, { headers: { host: "evil.example" } })).status, 400);
  for (const target of ["http://example.com/", "//example.com/styles.css"]) assert.equal((await f.request(target)).status, 400);
  for (const target of ["/", "/app.js", "/api/status", "/api/roon/queue", "/styles.css?target=example.com", reviewPath + "&access=" + KEY + "&extra=1", "/?access=" + KEY + "&sonicBlindBatch=blind%3Aother", gateway.PREFIX, gateway.PREFIX + "?batchId=blind%3Aother", gateway.PREFIX + "?" + batchQuery + "&" + batchQuery, gateway.PREFIX + "/report?" + batchQuery + "&extra=1", gateway.PREFIX + "/audio?" + batchQuery + "&clipId=" + OTHER, gateway.PREFIX + "/audio?" + batchQuery + "&clipId=../../secret"]) assert.equal((await f.request(target)).status, 404, target);
  for (const method of ["PUT", "DELETE", "OPTIONS", "POST"]) assert.equal((await f.request("/styles.css", { method })).status, 404);
  assert.equal(f.seen.length, 0);
  for (const target of [reviewPath, "/styles.css", "/sonicBlindReview.css", "/sonicBlindReview.js", gateway.PREFIX + "?" + batchQuery, gateway.PREFIX + "/report?" + batchQuery]) assert.equal((await f.request(target)).status, 200);
  assert.equal((await f.request("/styles.css", { method: "HEAD" })).status, 200);
});
test("POST requires same-origin, bounded JSON and the exact batch before reaching the fake upstream", async t => {
  const f = await fixture(t), target = gateway.PREFIX + "/save", headers = { "content-type": "application/json" };
  for (const origin of [undefined, "null", "https://unrelated.example", f.origin + "/"]) assert.equal((await f.request(target, { method: "POST", headers: { ...headers, ...(origin === undefined ? {} : { origin }) }, body: saveBody() })).status, 403);
  for (const value of [{ batchId: "blind:other" }, { ...JSON.parse(saveBody()), target: "http://example.com" }, [JSON.parse(saveBody())], null]) assert.equal((await f.request(target, { method: "POST", headers: { ...headers, origin: f.origin }, body: JSON.stringify(value) })).status, 400);
  assert.equal((await f.request(target, { method: "POST", headers: { origin: f.origin }, body: saveBody() })).status, 400);
  assert.equal((await f.request(target, { method: "POST", headers: { ...headers, origin: f.origin, "content-length": 20000 }, body: "x".repeat(20000) })).status, 413);
  assert.equal((await f.request(target, { method: "POST", headers: { ...headers, origin: f.origin }, chunks: ["x".repeat(9000), "y".repeat(9000)] })).status, 413);
  assert.equal(f.seen.length, 0);
  const good = await f.request(target, { method: "POST", headers: { ...headers, origin: f.origin, authorization: "Bearer fake-secret", cookie: cookie + "; unrelated=fake-secret" }, body: saveBody() });
  assert.equal(good.status, 200); assert.equal(good.headers["set-cookie"], undefined); assert.equal(good.headers["access-control-allow-origin"], undefined); assert.equal(f.seen.length, 1); assert.equal(f.seen[0].headers.host, "127.0.0.1:3791"); assert.equal(f.seen[0].headers.origin, "http://127.0.0.1:3791"); assert.equal(f.seen[0].headers.cookie, undefined); assert.equal(f.seen[0].headers.authorization, undefined); assert.deepEqual(JSON.parse(f.seen[0].body), JSON.parse(saveBody()));
});
test("audio HEAD and Range remain transparent without forwarding authentication", async t => {
  const f = await fixture(t), target = gateway.PREFIX + "/audio?" + batchQuery + "&clipId=" + CLIP;
  const head = await f.request(target, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(Number(head.headers["content-length"]), f.audio.length);
  const range = await f.request(target, { headers: { range: "bytes=0-3", "if-range": '"fixture-etag"', authorization: "Bearer secret" } }); assert.equal(range.status, 206); assert.deepEqual(range.bytes, f.audio.subarray(0, 4)); assert.equal(range.headers["content-range"], "bytes 0-3/" + f.audio.length); assert.equal(f.seen[1].headers.range, "bytes=0-3"); assert.equal(f.seen[1].headers["if-range"], '"fixture-etag"'); assert.equal(f.seen[1].headers.cookie, undefined); assert.equal(f.seen[1].headers.authorization, undefined);
});
test("input pins bind the exact published batch and existing upstream owner without changing files", t => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-phone-gateway-")), directory = path.join(artifactRoot, "data", "fresh"); fs.mkdirSync(directory, { recursive: true }); t.after(() => fs.rmSync(artifactRoot, { recursive: true, force: true }));
  const planBytes = Buffer.from(JSON.stringify({ version: 6, kind: "catalog-fresh-scout-quality", batchId: BATCH, count: 6, models: ["mert-30s"], groups: [{}], planKey: "fixture-plan", clips: { [CLIP]: { clipId: CLIP } } }));
  const rows = { "review-plan.json": planBytes, "publication.json": JSON.stringify({ batchId: BATCH, reviewPlanSha256: sha(planBytes), mainDatabaseRowsInserted: 0, hostCode: { files: [{ path: SCRIPT, sha256: sha(fs.readFileSync(path.join(ROOT, SCRIPT))) }] } }), "host-runtime.json": JSON.stringify({ batchId: BATCH, reviewPlanSha256: sha(planBytes), planKey: "fixture-plan", host: "127.0.0.1", port: 3791, pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }) };
  for (const [name, bytes] of Object.entries(rows)) fs.writeFileSync(path.join(directory, name), bytes);
  const before = Object.keys(rows).map(name => sha(fs.readFileSync(path.join(directory, name)))), context = gateway.loadInputs({ directory, artifactRoot, projectRoot: ROOT }); assert.equal(context.batchId, BATCH); assert.deepEqual([...context.clipIds], [CLIP]); assert.equal(context.pins.length, 4); assert.deepEqual(Object.keys(rows).map(name => sha(fs.readFileSync(path.join(directory, name)))), before); assert.equal(fs.existsSync(path.join(directory, "phone-gateway-runtime.json")), false);
  const runtime = JSON.parse(rows["host-runtime.json"]); runtime.port = 3777; fs.writeFileSync(path.join(directory, "host-runtime.json"), JSON.stringify(runtime)); assert.throws(() => gateway.loadInputs({ directory, artifactRoot, projectRoot: ROOT }));
});
test("cleanup deletes only its matching private ownership record", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-phone-owner-")), file = path.join(directory, "phone-gateway-runtime.json"), owner = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }; t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify(owner)); assert.throws(() => gateway.removeOwnedRuntime(file, { ...owner, token: randomUUID() })); assert.ok(fs.existsSync(file)); assert.throws(() => gateway.removeOwnedRuntime(file, { ...owner, pid: owner.pid + 1 })); assert.ok(fs.existsSync(file)); gateway.removeOwnedRuntime(file, owner); assert.equal(fs.existsSync(file), false); gateway.removeOwnedRuntime(file, owner);
});
test("root can reuse a validated access key without adding a CLI secret option", () => {
  assert.equal(gateway.accessKeyFor(KEY), KEY); assert.match(gateway.accessKeyFor(), /^[a-f0-9]{64}$/);
  for (const value of [null, "", "1".repeat(63), "1".repeat(65), "x".repeat(64), 123]) assert.throws(() => gateway.accessKeyFor(value));
  assert.throws(() => gateway.argumentsFor(["serve", "--directory", "data/fresh", "--host", "192.168.50.119", "--access-key", KEY]));
});
