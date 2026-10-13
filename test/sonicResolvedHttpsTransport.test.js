"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream"), zlib = require("node:zlib");
const { createResolvedHttpsFetch, RESOLVED_HTTPS_POLICY } = require("../src/sonicResolvedHttpsTransport");
function fixture({ bytes = Buffer.from('{"ok":true}'), status = 200, headers = { "content-type": "application/json" }, responseError = null,
  requestError = null, complete = true, hold = false, addresses = ["192.0.2.10", "192.0.2.11"] } = {}) {
  const calls = { dns: [], requests: [], bodies: [], destroyed: 0, lookup: [] }; let activeResponse, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const fetch = createResolvedHttpsFetch({ resolve4Impl: async hostname => { calls.dns.push(hostname); return addresses; },
    requestImpl: (options, callback) => {
      calls.requests.push(options); markStarted();
      options.lookup(options.hostname, {}, (...values) => calls.lookup.push(values));
      const request = new EventEmitter(); request.destroy = () => { calls.destroyed++; };
      request.end = body => { calls.bodies.push(body);
        if (hold) return;
        queueMicrotask(() => {
          if (requestError) { request.emit("error", Error(requestError)); return; }
          const incoming = new PassThrough(); activeResponse = incoming; incoming.statusCode = status; incoming.headers = headers; incoming.complete = complete;
          callback(incoming);
          if (responseError) incoming.destroy(Error(responseError)); else if (!incoming.destroyed) incoming.end(bytes);
        });
      }; return request;
    } });
  return { fetch, calls, response: () => activeResponse, started };
}
function safe(error, expected) {
  assert.equal(error.code, expected); assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /SECRET|private\.invalid|private-path|authorization|client_secret/);
  assert.equal(error.cause, undefined); return true;
}
test("one DNS resolution selects one IPv4 while retaining hostname, Host and TLS verification", async () => {
  const f = fixture(), response = await f.fetch(new URL("https://private.invalid:8443/private-path?secret=SECRET"));
  assert.equal(response instanceof Response, true); assert.equal(response.ok, true); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(f.calls.dns, ["private.invalid"]); assert.equal(f.calls.requests.length, 1); assert.deepEqual(f.calls.lookup, [[null, "192.0.2.10", 4]]);
  const options = f.calls.requests[0]; assert.equal(options.hostname, "private.invalid"); assert.equal(options.servername, "private.invalid");
  assert.equal(options.headers.host, "private.invalid:8443"); assert.equal(options.headers["accept-encoding"], "identity");
  assert.equal(options.rejectUnauthorized, true); assert.equal(options.autoSelectFamily, false); assert.equal(options.family, 4); assert.equal(options.agent, false);
  assert.equal(options.port, "8443"); assert.equal(options.path, "/private-path?secret=SECRET");
  options.lookup(options.hostname, { all: true }, (error, addresses) => assert.deepEqual(addresses, [{ address: "192.0.2.10", family: 4 }]));
  assert.equal(RESOLVED_HTTPS_POLICY.maximumPhysicalRequests, 1); assert.equal(RESOLVED_HTTPS_POLICY.retries, 0);
});
test("raw audio bytes, native Headers and clone/text/json methods remain compatible", async () => {
  const bytes = Buffer.from([0, 255, 128, 20]), f = fixture({ bytes, headers: { "content-type": "audio/mpeg", "x-test": "yes" } });
  const response = await f.fetch("https://private.invalid/audio", { headers: new Headers({ authorization: "Bearer SECRET", Host: "wrong.invalid", "accept-encoding": "gzip" }) });
  assert.equal(response.headers.get("x-test"), "yes"); assert.equal(response.headers.get("content-length"), String(bytes.length));
  assert.deepEqual(Buffer.from(await response.clone().arrayBuffer()), bytes); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(f.calls.requests[0].headers.authorization, "Bearer SECRET"); assert.equal(f.calls.requests[0].headers.host, "private.invalid");
  assert.equal(f.calls.requests[0].headers["accept-encoding"], "identity");
});
test("POST authentication strings and URLSearchParams retain their original bytes without error disclosure", async () => {
  for (const body of [new URLSearchParams({ grant_type: "refresh_token", client_secret: "SECRET & +", refresh_token: "SECRET" }), "client_secret=SECRET&grant_type=test"]) {
    const f = fixture(), expected = Buffer.from(String(body));
    await f.fetch("https://private.invalid/oauth", { method: "POST", body, headers: { authorization: "Bearer SECRET" } });
    assert.deepEqual(f.calls.bodies, [expected]); assert.equal(f.calls.requests[0].method, "POST"); assert.equal(f.calls.requests[0].headers["content-length"], String(expected.byteLength));
    const bad = fixture({ requestError: "PRIVATE https://private.invalid client_secret=SECRET" });
    await assert.rejects(bad.fetch("https://private.invalid/oauth", { method: "POST", body }), error => safe(error, "HTTPS_REQUEST_FAILED"));
    assert.equal(bad.calls.requests.length, 1); assert.equal(bad.calls.dns.length, 1);
  }
});
test("redirect statuses are returned without following Location or changing the request", async () => {
  const f = fixture({ status: 302, bytes: Buffer.from("redirect"), headers: { location: "https://other.invalid/?token=SECRET" } });
  const response = await f.fetch("https://private.invalid/start"); assert.equal(response.status, 302); assert.equal(response.ok, false);
  assert.equal(response.redirected, false); assert.equal(await response.text(), "redirect"); assert.equal(f.calls.requests.length, 1); assert.equal(f.calls.dns.length, 1);
});
test("gzip, Brotli and compliant deflate decode with accurate bounded response bytes", async () => {
  const payload = Buffer.from(JSON.stringify({ message: "a finite server-compressed response" }));
  for (const [encoding, compress] of [["gzip", zlib.gzipSync], ["br", zlib.brotliCompressSync], ["deflate", zlib.deflateSync]]) {
    const bytes = compress(payload), f = fixture({ bytes, headers: { "content-encoding": encoding, "content-length": String(bytes.length) } });
    const response = await f.fetch("https://private.invalid/json"); assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
    assert.equal(response.headers.get("content-encoding"), null); assert.equal(response.headers.get("content-length"), String(payload.length));
    assert.equal(f.calls.requests.length, 1);
  }
});
test("original and decompressed body limits stop the one request rather than falling back", async () => {
  const maximum = RESOLVED_HTTPS_POLICY.maximumOriginalBodyBytes;
  for (const input of [{ bytes: Buffer.from("short"), headers: { "content-length": String(maximum + 1) } },
    { bytes: Buffer.alloc(maximum + 1), headers: {} }]) {
    const f = fixture(input); await assert.rejects(f.fetch("https://private.invalid/audio"), error => safe(error, "HTTPS_ORIGINAL_BODY_LIMIT"));
    assert.equal(f.calls.requests.length, 1); assert.equal(f.calls.dns.length, 1); assert.ok(f.calls.destroyed >= 1);
  }
  const f = fixture({ bytes: zlib.gzipSync(Buffer.alloc(maximum + 1)), headers: { "content-encoding": "gzip" } });
  await assert.rejects(f.fetch("https://private.invalid/audio"), error => safe(error, "HTTPS_DECODED_BODY_LIMIT"));
  assert.equal(f.calls.requests.length, 1); assert.equal(f.calls.dns.length, 1);
});
test("DNS, malformed encoding and incomplete response errors remain sanitized and never retry", async () => {
  let resolves = 0, requests = 0;
  const fetch = createResolvedHttpsFetch({ resolve4Impl: async () => { resolves++; throw Object.assign(Error("private-path SECRET EAI_AGAIN"), { code: "EAI_AGAIN" }); }, requestImpl: () => { requests++; } });
  await assert.rejects(fetch("https://private.invalid/secret"), error => safe(error, "HTTPS_DNS_FAILED")); assert.equal(resolves, 1); assert.equal(requests, 0);
  const invalidAddress = fixture({ addresses: ["bad", "192.0.2.10"] });
  await assert.rejects(invalidAddress.fetch("https://private.invalid/secret"), error => safe(error, "HTTPS_DNS_FAILED")); assert.equal(invalidAddress.calls.requests.length, 0);
  for (const [options, code] of [[{ bytes: Buffer.from("invalid gzip"), headers: { "content-encoding": "gzip" } }, "HTTPS_DECODE_FAILED"],
    [{ headers: { "content-encoding": "unknown" } }, "HTTPS_UNSUPPORTED_ENCODING"], [{ complete: false }, "HTTPS_RESPONSE_FAILED"],
    [{ responseError: "SECRET private-path" }, "HTTPS_RESPONSE_FAILED"]]) {
    const f = fixture(options); await assert.rejects(f.fetch("https://private.invalid/secret"), error => safe(error, code));
    assert.equal(f.calls.dns.length, 1); assert.equal(f.calls.requests.length, 1);
  }
});
test("abort before start or during DNS makes no physical request and never exposes signal reasons", async () => {
  const controller = new AbortController(); controller.abort("SECRET private-path"); const f = fixture();
  await assert.rejects(f.fetch("https://private.invalid/secret", { signal: controller.signal }), error => error.name === "AbortError" && !/SECRET|private-path/.test(error.message));
  assert.equal(f.calls.dns.length, 0); assert.equal(f.calls.requests.length, 0);
  let finishDns, resolves = 0, requests = 0;
  const slow = createResolvedHttpsFetch({ resolve4Impl: () => { resolves++; return new Promise(resolve => { finishDns = resolve; }); }, requestImpl: () => { requests++; } });
  const during = new AbortController(), promise = slow("https://private.invalid/secret", { signal: during.signal });
  await Promise.resolve(); during.abort("SECRET"); await assert.rejects(promise, error => error.name === "AbortError");
  finishDns(["192.0.2.10"]); await Promise.resolve(); assert.equal(resolves, 1); assert.equal(requests, 0);
});
test("abort during the request releases its handle without additional DNS or requests", async () => {
  const f = fixture({ hold: true }), controller = new AbortController(), promise = f.fetch("https://private.invalid/secret", { signal: controller.signal });
  await f.started; controller.abort("SECRET");
  await assert.rejects(promise, error => error.name === "AbortError" && !/SECRET|private-path/.test(error.message));
  assert.equal(f.calls.requests.length, 1); assert.equal(f.calls.dns.length, 1); assert.ok(f.calls.destroyed >= 1);
});
test("unsupported protocols, methods and body types reject safely before resolving or requesting", async () => {
  const f = fixture();
  for (const [url, options] of [["http://private.invalid/SECRET", {}], ["https://user:SECRET@private.invalid/", {}],
    ["SECRET malformed URL", {}], ["https://private.invalid/", { method: "PUT" }], ["https://private.invalid/", { body: "SECRET" }],
    ["https://private.invalid/", { method: "POST", body: { client_secret: "SECRET" } }]])
    await assert.rejects(f.fetch(url, options), error => safe(error, "HTTPS_INVALID_INPUT"));
  assert.equal(f.calls.requests.length, 0); assert.equal(f.calls.dns.length, 0);
});
test("errors thrown by custom input coercion cannot imitate a trusted transport error", async () => {
  const f = fixture(), url = { toString() { throw Object.assign(Error("SECRET private-path"), { code: "HTTPS_INVALID_INPUT" }); } };
  await assert.rejects(f.fetch(url), error => safe(error, "HTTPS_INVALID_INPUT"));
  const signal = { aborted: false, addEventListener() { throw Error("SECRET private-path"); }, removeEventListener() { throw Error("SECRET"); } };
  await assert.rejects(f.fetch("https://private.invalid/", { signal }), error => safe(error, "HTTPS_INVALID_INPUT"));
  assert.equal(f.calls.requests.length, 0); assert.equal(f.calls.dns.length, 0);
});
