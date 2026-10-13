"use strict";

// An opt-in, single-review LAN entrance to the existing localhost host.
// It neither imports the main server nor opens a database or media player.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), os = require("node:os"), net = require("node:net");
const assert = require("node:assert/strict"), { createHash, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { privateDirectory, safeFile } = require("./sonic-catalog-fresh-review-host");
const ROOT = path.resolve(__dirname, ".."), SCRIPT = "scripts/sonic-catalog-verified-recovery-phone-gateway.js";
const PREFIX = "/api/recommendation-v2/sonic-review/blind";
function cookieFor(batchId) { assert.ok(typeof batchId === "string" && /^blind:[a-f0-9-]{36}$/.test(batchId)); return "rh_review_" + sha(batchId).slice(0, 16); }
const STATIC = new Set(["/styles.css", "/sonicBlindReview.css", "/sonicBlindReview.js"]), MAX_BODY = 16384;
const sha = bytes => createHash("sha256").update(bytes).digest("hex"), read = file => JSON.parse(fs.readFileSync(file));
const writeNew = (file, row) => fs.writeFileSync(file, JSON.stringify(row, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function argumentsFor(argv) {
  const [stage, ...args] = argv; assert.equal(stage, "serve", "Choose serve for the phone entrance.");
  const result = { port: 3792 }, seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]; assert.ok(["--directory", "--host", "--port"].includes(key) && !seen.has(key), "Unknown or repeated phone-entrance option."); seen.add(key);
    const value = args[++index]; assert.ok(value && !value.startsWith("--"), "A phone-entrance option needs a value.");
    if (key === "--directory") result.directory = path.resolve(ROOT, value);
    else if (key === "--host") result.host = value;
    else result.port = Number(value);
  }
  assert.ok(result.directory && net.isIP(result.host || "") === 4 && result.host !== "0.0.0.0", "Declare a private directory and an explicit local IPv4 address.");
  assert.ok(Number.isInteger(result.port) && result.port >= 1024 && result.port <= 65535 && ![3777, 3789, 3790, 3797].includes(result.port), "Choose a separate unprivileged port.");
  return result;
}
function loadInputs({ directory, projectRoot = ROOT, artifactRoot = ROOT }) {
  directory = privateDirectory(directory, artifactRoot);
  const files = ["review-plan.json", "publication.json", "host-runtime.json"].map(name => ({ name, file: safeFile(directory, path.join(directory, name)) }));
  const contents = files.map(row => fs.readFileSync(row.file)), [plan, publication, upstreamRuntime] = contents.map(bytes => JSON.parse(bytes));
  assert.equal(plan.version, 7); assert.equal(plan.kind, "catalog-verified-scout-quality"); assert.deepEqual(plan.models, ["mert-30s"]); const batchId = plan.batchId; cookieFor(batchId);
  assert.ok(Number.isInteger(plan.count) && plan.count > 0 && plan.count <= 12 && Array.isArray(plan.groups) && plan.groups.length > 0 && plan.groups.length <= 4);
  assert.equal(publication.batchId, batchId); assert.equal(publication.reviewPlanSha256, sha(contents[0])); assert.equal(publication.mainDatabaseRowsInserted, 0);
  assert.equal(upstreamRuntime.batchId, batchId); assert.equal(upstreamRuntime.reviewPlanSha256, sha(contents[0])); assert.equal(upstreamRuntime.planKey, plan.planKey);
  assert.equal(upstreamRuntime.host, "127.0.0.1"); assert.ok(Number.isInteger(upstreamRuntime.port) && upstreamRuntime.port >= 1024 && upstreamRuntime.port <= 65535 && ![3777, 3797].includes(upstreamRuntime.port));
  const upstream = Object.freeze({ hostname: "127.0.0.1", port: upstreamRuntime.port });
  assert.ok(Number.isInteger(upstreamRuntime.pid) && upstreamRuntime.pid > 0 && typeof upstreamRuntime.token === "string" && typeof upstreamRuntime.startedAt === "string");
  process.kill(upstreamRuntime.pid, 0);
  const clipIds = Object.keys(plan.clips || {}); assert.ok(clipIds.length > 0 && clipIds.length <= 16 && clipIds.every(id => /^[a-f0-9]{64}$/.test(id) && plan.clips[id].clipId === id));
  assert.ok(Array.isArray(publication.hostCode?.files) && publication.hostCode.files.length > 0);
  for (const row of publication.hostCode.files) assert.equal(sha(fs.readFileSync(safeFile(projectRoot, path.join(projectRoot, row.path)))), row.sha256, "The published upstream code changed.");
  const pins = files.map((row, index) => ({ path: row.name, sha256: sha(contents[index]) }));
  pins.push({ path: SCRIPT, sha256: sha(fs.readFileSync(safeFile(projectRoot, path.join(projectRoot, SCRIPT)))) });
  return { directory, batchId, count: plan.count, clipIds: new Set(clipIds), upstream, upstreamRuntime, pins, files };
}
function matchesKey(value, key) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(key, "hex"));
}
function authorized(req, key, cookie) {
  const cookies = (req.headers.cookie || "").split(";").map(part => part.trim()).filter(part => part.startsWith(cookie + "="));
  return cookies.length === 1 && matchesKey(cookies[0].slice(cookie.length + 1), key);
}
function send(res, status, error) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  res.end(JSON.stringify({ ok: false, error }));
}
function exactQuery(url, fields) {
  const keys = [...url.searchParams.keys()]; return keys.length === fields.length && keys.every(key => fields.includes(key)) && fields.every(key => url.searchParams.getAll(key).length === 1);
}
function body(req, batchId) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) { req.resume(); return reject(Object.assign(Error(), { status: 400 })); }
    let length = 0, chunks = [], failed = false;
    const fail = status => { if (failed) return; failed = true; chunks = []; reject(Object.assign(Error(), { status })); };
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) { req.resume(); return fail(413); }
    req.on("data", chunk => { if (failed) return; length += chunk.length; if (length > MAX_BODY) return fail(413); chunks.push(chunk); });
    req.once("aborted", () => fail(400)); req.once("error", () => fail(400));
    req.once("end", () => { if (failed) return; try { const value = JSON.parse(Buffer.concat(chunks)); assert.ok(value && typeof value === "object" && !Array.isArray(value) && value.batchId === batchId && Object.keys(value).every(key => ["batchId", "sessionId", "index", "decision", "listened", "note"].includes(key))); resolve(Buffer.from(JSON.stringify(value))); } catch { fail(400); } });
  });
}
function bootstrapHTML(bytes, reviewPath) {
  const html = bytes.toString("utf8"); assert.ok(html.includes("<head>"), "The listening shell needs its existing head.");
  return Buffer.from(html.replace("<head>", `<head><script>history.replaceState(null,"",${JSON.stringify(reviewPath)});</script>`));
}
function proxy(req, res, context, upstreamPath, bytes, request = http.request, bootstrap) {
  return new Promise(resolve => {
    const upstreamAuthority = context.upstream.hostname + ":" + context.upstream.port, headers = { host: upstreamAuthority };
    for (const name of ["accept", "range", "if-range"]) if (req.headers[name]) headers[name] = req.headers[name];
    if (bytes) Object.assign(headers, { "content-type": "application/json", "content-length": bytes.length, origin: "http://" + upstreamAuthority });
    const outgoing = request({ ...context.upstream, method: req.method, path: upstreamPath, headers }, incoming => {
      if (Number(incoming.headers["content-length"] || 0) > 3 * 1024 * 1024 || incoming.headers.location) { incoming.destroy(); send(res, 502, "Listening host response unavailable."); return resolve(); }
      const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) if (incoming.headers[name]) responseHeaders[name] = incoming.headers[name];
      if (bootstrap) {
        if (incoming.statusCode !== 200 || !/^text\/html(?:\s*;|$)/i.test(incoming.headers["content-type"] || "")) { incoming.resume(); send(res, 502, "Listening page unavailable."); return resolve(); }
        let length = 0, chunks = [], failed = false;
        const fail = () => { if (failed) return; failed = true; chunks = []; if (!res.headersSent) send(res, 502, "Listening page unavailable."); resolve(); };
        incoming.once("error", fail);
        incoming.on("data", chunk => { if (failed) return; length += chunk.length; if (length > 3 * 1024 * 1024) { fail(); incoming.destroy(); } else chunks.push(chunk); });
        incoming.once("end", () => {
          if (failed) return;
          try {
            const html = bootstrapHTML(Buffer.concat(chunks), bootstrap.reviewPath);
            delete responseHeaders.etag; delete responseHeaders["last-modified"];
            Object.assign(responseHeaders, { "content-length": html.length, "Set-Cookie": `${bootstrap.cookie}=${bootstrap.accessKey}; HttpOnly; SameSite=Strict; Path=/` });
            res.writeHead(200, responseHeaders); res.end(html); resolve();
          } catch { fail(); }
        });
        return;
      }
      res.writeHead(incoming.statusCode, responseHeaders); let length = 0;
      incoming.on("data", chunk => { length += chunk.length; if (length > 3 * 1024 * 1024) incoming.destroy(); });
      incoming.once("error", () => { res.destroy(); resolve(); }); incoming.once("end", resolve); incoming.pipe(res);
    });
    outgoing.setTimeout(15000, () => outgoing.destroy());
    outgoing.once("error", () => { if (!res.headersSent) send(res, 502, "Listening host unavailable."); else res.destroy(); resolve(); });
    res.once("close", () => { if (!res.writableEnded) outgoing.destroy(); }); outgoing.end(bytes);
  });
}
function createGatewayHandler(context, { request = http.request } = {}) {
  const batchId = context.batchId, cookie = cookieFor(batchId); assert.ok(/^[a-f0-9]{64}$/.test(context.accessKey));
  assert.equal(context.upstream?.hostname, "127.0.0.1"); assert.ok(Number.isInteger(context.upstream.port) && context.upstream.port >= 1024 && context.upstream.port <= 65535 && ![3777, 3797].includes(context.upstream.port));
  assert.ok(context.clipIds instanceof Set && context.clipIds.size > 0 && context.clipIds.size <= 16 && [...context.clipIds].every(id => /^[a-f0-9]{64}$/.test(id)));
  const authority = context.host + ":" + context.port, origin = "http://" + authority, reviewPath = "/?sonicBlindBatch=" + encodeURIComponent(batchId);
  return async (req, res) => {
    try {
      if (req.headers.host !== authority || !req.url.startsWith("/") || req.url.startsWith("//")) return send(res, 400, "Use the declared phone entrance.");
      const url = new URL(req.url, origin), pathname = url.pathname;
      const bootstrap = exactQuery(url, ["access"]) || (exactQuery(url, ["access", "sonicBlindBatch"]) && url.searchParams.get("sonicBlindBatch") === batchId);
      if (req.method === "GET" && pathname === "/" && bootstrap) {
        if (!matchesKey(url.searchParams.get("access"), context.accessKey)) return send(res, 401, "Listening access required.");
        return await proxy(req, res, context, reviewPath, undefined, request, { reviewPath, accessKey: context.accessKey, cookie });
      }
      if (!authorized(req, context.accessKey, cookie)) return send(res, 401, "Listening access required.");
      let allowed = req.method === "GET" && pathname === "/" && exactQuery(url, ["sonicBlindBatch"]) && url.searchParams.get("sonicBlindBatch") === batchId;
      allowed ||= ["GET", "HEAD"].includes(req.method) && STATIC.has(pathname) && exactQuery(url, []);
      allowed ||= req.method === "GET" && [PREFIX, PREFIX + "/report"].includes(pathname) && exactQuery(url, ["batchId"]) && url.searchParams.get("batchId") === batchId;
      allowed ||= ["GET", "HEAD"].includes(req.method) && pathname === PREFIX + "/audio" && exactQuery(url, ["batchId", "clipId"]) && url.searchParams.get("batchId") === batchId && /^[a-f0-9]{64}$/.test(url.searchParams.get("clipId") || "") && context.clipIds.has(url.searchParams.get("clipId"));
      const save = req.method === "POST" && pathname === PREFIX + "/save" && exactQuery(url, []);
      if (!allowed && !save) return send(res, 404, "Listening route unavailable.");
      if (save && req.headers.origin !== origin) { req.resume(); return send(res, 403, "Use this listening page to save."); }
      const bytes = save ? await body(req, batchId) : undefined;
      return await proxy(req, res, context, pathname + url.search, bytes, request);
    } catch (error) { if (!res.headersSent) send(res, error.status || 400, "Listening request could not be completed."); else res.destroy(); }
  };
}
async function verifyUpstream(context) {
  const batchId = context.batchId;
  const value = await new Promise((resolve, reject) => {
    const outgoing = http.get({ ...context.upstream, path: PREFIX + "?batchId=" + encodeURIComponent(batchId), headers: { host: context.upstream.hostname + ":" + context.upstream.port } }, incoming => {
      let length = 0, chunks = []; incoming.on("data", chunk => { length += chunk.length; if (length > 128 * 1024) incoming.destroy(); else chunks.push(chunk); });
      incoming.once("error", reject); incoming.once("end", () => { try { assert.equal(incoming.statusCode, 200); resolve(JSON.parse(Buffer.concat(chunks))); } catch (error) { reject(error); } });
    }); outgoing.setTimeout(10000, () => outgoing.destroy()); outgoing.once("error", reject);
  });
  assert.equal(value.batch?.batchId, batchId); assert.equal(value.batch.count, context.count);
  for (const row of context.files) assert.equal(sha(fs.readFileSync(row.file)), context.pins.find(pin => pin.path === row.name).sha256, "The upstream binding changed during startup.");
}
function removeOwnedRuntime(file, owner) {
  if (!fs.existsSync(file)) return;
  const row = read(file); assert.equal(row.token, owner.token); assert.equal(row.pid, owner.pid); assert.equal(row.startedAt, owner.startedAt); fs.unlinkSync(file);
}
function accessKeyFor(value) {
  assert.ok(value === undefined || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)), "A reused phone access key must be exactly 256 bits.");
  return value ?? randomBytes(32).toString("hex");
}
async function startGateway(options) {
  assert.ok(net.isIP(options.host || "") === 4 && options.host !== "0.0.0.0" && Object.values(os.networkInterfaces()).flat().some(row => row?.family === "IPv4" && row.address === options.host), "Bind an IPv4 address currently owned by this computer.");
  assert.ok(Number.isInteger(options.port) && options.port >= 1024 && options.port <= 65535 && ![3777, 3789, 3790, 3797].includes(options.port));
  const accessKey = accessKeyFor(options.accessKey), context = loadInputs(options), batchId = context.batchId, runtimeFile = path.join(context.directory, "phone-gateway-runtime.json");
  assert.notEqual(options.port, context.upstream.port, "The phone entrance must have a separate port.");
  const inputs = require("./sonic-catalog-verified-review-host").loadInputs(context.directory, options);
  require("./sonic-catalog-verified-review-host").validateAgainstMain(inputs, options);
  require("./sonic-catalog-verified-recovery-review").validateReviewPlan(inputs.plan, { artifactRoot: options.artifactRoot || ROOT });
  assert.ok(!fs.existsSync(runtimeFile), "Preserve the existing phone-entrance ownership record."); await verifyUpstream(context);
  const owner = { token: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() };
  const server = http.createServer(createGatewayHandler({ ...context, host: options.host, port: options.port, accessKey })); server.requestTimeout = 15000; server.headersTimeout = 10000; server.timeout = 30000;
  let recorded = false, closed = false;
  async function close() { if (closed) return; closed = true; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); if (recorded) removeOwnedRuntime(runtimeFile, owner); }
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, resolve); });
    const receiptName = "phone-gateway-startup-" + owner.token + ".json", receipt = { version: 1, ...owner, host: options.host, port: options.port, batchId: batchId, upstream: "http://" + context.upstream.hostname + ":" + context.upstream.port, pins: context.pins, productionApplied: false, mainDatabaseRowsInserted: 0 };
    writeNew(path.join(context.directory, receiptName), receipt);
    writeNew(runtimeFile, { version: 1, ...owner, host: options.host, port: options.port, batchId: batchId, accessKey, startupReceipt: receiptName, startupReceiptSha256: sha(fs.readFileSync(path.join(context.directory, receiptName))), productionApplied: false }); recorded = true;
    return { server, close, host: options.host, port: options.port, batchId: batchId, count: context.count, url: `http://${options.host}:${options.port}/?access=${accessKey}` };
  } catch (error) { await close(); throw error; }
}
async function main(argv = process.argv.slice(2)) {
  const gateway = await startGateway(argumentsFor(argv));
  console.log(JSON.stringify({ phoneGateway: true, host: gateway.host, port: gateway.port, batchId: gateway.batchId, count: gateway.count, accessFile: "phone-gateway-runtime.json", productionApplied: false }));
  let stopping = false; const stop = async () => { if (stopping) return; stopping = true; try { await gateway.close(); } catch { process.exitCode = 1; } };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
if (require.main === module) main().catch(() => { console.error("The private phone entrance could not start. Inspect its declared address and ownership receipts."); process.exitCode = 1; });
module.exports = { argumentsFor, loadInputs, matchesKey, bootstrapHTML, createGatewayHandler, removeOwnedRuntime, accessKeyFor, startGateway, main, PREFIX, cookieFor };
