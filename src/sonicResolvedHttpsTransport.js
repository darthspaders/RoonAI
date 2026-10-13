"use strict";

// Instance-local, single-attempt HTTPS transport. No fallback resolver, redirect,
// retry, global fetch change or DNS configuration is performed by this module.
const https = require("node:https"), dns = require("node:dns"), zlib = require("node:zlib");
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const safeErrors = new WeakSet();
const RESOLVED_HTTPS_POLICY = Object.freeze({ version: 1, kind: "single-resolved-ipv4-https", dnsMethod: "resolve4",
  maximumDnsCallsPerRequest: 1, selectedAddressCount: 1, maximumPhysicalRequests: 1, redirects: 0, retries: 0, fallbacks: 0,
  autoSelectFamily: false, rejectUnauthorized: true, acceptEncoding: "identity", maximumOriginalBodyBytes: MAX_BODY_BYTES,
  maximumDecodedBodyBytes: MAX_BODY_BYTES, supportedContentEncodings: Object.freeze(["identity", "gzip", "br", "deflate"]) });
const ipv4 = value => typeof value === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
  && value.split(".").every(part => String(Number(part)) === part && Number(part) <= 255);
function transportError(code) {
  const error = new TypeError("Resolved HTTPS request failed."); error.code = code; safeErrors.add(error); return error;
}
function abortError() {
  return new DOMException("Resolved HTTPS request aborted.", "AbortError");
}
function requestInput(input, init) {
  if (!init || typeof init !== "object" || Array.isArray(init)) throw transportError("HTTPS_INVALID_INPUT");
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.hostname.includes(":"))
    throw transportError("HTTPS_INVALID_INPUT");
  const method = String(init.method ?? "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw transportError("HTTPS_INVALID_INPUT");
  const headers = new Headers(init.headers || {});
  headers.set("host", url.host); headers.set("accept-encoding", "identity");
  let body = null;
  if (init.body !== undefined && init.body !== null) {
    if (method !== "POST" || !(typeof init.body === "string" || init.body instanceof URLSearchParams)) throw transportError("HTTPS_INVALID_INPUT");
    body = Buffer.from(String(init.body));
    if (body.byteLength > MAX_BODY_BYTES) throw transportError("HTTPS_REQUEST_BODY_LIMIT");
    if (!headers.has("content-type")) headers.set("content-type", init.body instanceof URLSearchParams
      ? "application/x-www-form-urlencoded;charset=UTF-8" : "text/plain;charset=UTF-8");
    headers.set("content-length", String(body.byteLength));
  } else { headers.delete("content-length"); }
  if (Buffer.byteLength(JSON.stringify([...headers])) > 64 * 1024) throw transportError("HTTPS_INVALID_INPUT");
  const signal = init.signal;
  if (signal !== undefined && signal !== null && (typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function")) throw transportError("HTTPS_INVALID_INPUT");
  return { url, method, headers: Object.fromEntries(headers), body, signal };
}
function responseHeaders(incoming) {
  const headers = new Headers();
  if (Array.isArray(incoming.rawHeaders)) {
    if (incoming.rawHeaders.length > 512 || incoming.rawHeaders.length % 2) throw transportError("HTTPS_INVALID_RESPONSE");
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
  } else for (const [key, value] of Object.entries(incoming.headers || {})) {
    for (const part of Array.isArray(value) ? value : [value]) if (part !== undefined) headers.append(key, String(part));
  }
  if (Buffer.byteLength(JSON.stringify([...headers])) > 64 * 1024) throw transportError("HTTPS_INVALID_RESPONSE");
  return headers;
}
function createResolvedHttpsFetch({ resolve4Impl = hostname => dns.promises.resolve4(hostname), requestImpl = https.request } = {}) {
  if (typeof resolve4Impl !== "function" || typeof requestImpl !== "function") throw transportError("HTTPS_INVALID_INPUT");
  return function resolvedHttpsFetch(input, init = {}) {
    let parsed;
    try { parsed = requestInput(input, init); }
    catch (error) { return Promise.reject(safeErrors.has(error) ? error : transportError("HTTPS_INVALID_INPUT")); }
    const { url, method, headers, body, signal } = parsed;
    return new Promise((resolve, reject) => {
      let request, incoming, decoder, settled = false;
      const cleanup = () => { try { signal?.removeEventListener("abort", onAbort); } catch { /* Never disclose caller signal errors. */ } };
      const stop = stream => { try { stream?.destroy(); } catch { /* No raw platform diagnostics escape. */ } };
      const fail = error => {
        if (settled) return; settled = true; cleanup(); stop(decoder); stop(incoming); stop(request); reject(error);
      };
      const onAbort = () => fail(abortError());
      try {
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener("abort", onAbort, { once: true });
      } catch { fail(transportError("HTTPS_INVALID_INPUT")); return; }
      const onResponse = stream => {
        if (settled) { stop(stream); return; }
        incoming = stream;
        incoming.on("error", () => fail(transportError("HTTPS_RESPONSE_FAILED")));
        incoming.on("aborted", () => fail(transportError("HTTPS_RESPONSE_FAILED")));
        let responseHeader, encoding, originalBytes = 0, decodedBytes = 0;
        const chunks = [];
        try {
          if (!Number.isInteger(incoming.statusCode) || incoming.statusCode < 200 || incoming.statusCode > 599) throw transportError("HTTPS_INVALID_RESPONSE");
          responseHeader = responseHeaders(incoming);
          const length = responseHeader.get("content-length");
          if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw transportError("HTTPS_ORIGINAL_BODY_LIMIT");
          encoding = (responseHeader.get("content-encoding") || "identity").trim().toLowerCase();
          if (!RESOLVED_HTTPS_POLICY.supportedContentEncodings.includes(encoding)) throw transportError("HTTPS_UNSUPPORTED_ENCODING");
          decoder = encoding === "gzip" ? zlib.createGunzip() : encoding === "br" ? zlib.createBrotliDecompress()
            : encoding === "deflate" ? zlib.createInflate() : null;
        } catch (error) { fail(safeErrors.has(error) ? error : transportError("HTTPS_INVALID_RESPONSE")); return; }
        incoming.on("data", chunk => {
          if (settled) return;
          originalBytes += chunk.byteLength;
          if (originalBytes > MAX_BODY_BYTES) fail(transportError("HTTPS_ORIGINAL_BODY_LIMIT"));
        });
        const output = decoder || incoming;
        if (decoder) decoder.on("error", () => fail(transportError("HTTPS_DECODE_FAILED")));
        output.on("data", chunk => {
          if (settled) return;
          decodedBytes += chunk.byteLength;
          if (decodedBytes > MAX_BODY_BYTES) { fail(transportError("HTTPS_DECODED_BODY_LIMIT")); return; }
          chunks.push(chunk);
        });
        output.on("end", () => {
          if (settled) return;
          if (incoming.complete === false) { fail(transportError("HTTPS_RESPONSE_FAILED")); return; }
          try {
            const bytes = Buffer.concat(chunks, decodedBytes);
            responseHeader.delete("content-encoding"); responseHeader.set("content-length", String(decodedBytes));
            const response = new Response([204, 205, 304].includes(incoming.statusCode) ? null : bytes,
              { status: incoming.statusCode, headers: responseHeader });
            Object.defineProperty(response, "url", { value: url.href });
            settled = true; cleanup(); resolve(response);
          } catch { fail(transportError("HTTPS_INVALID_RESPONSE")); }
        });
        incoming.on("close", () => {
          if (!settled && incoming.complete === false) fail(transportError("HTTPS_RESPONSE_FAILED"));
        });
        if (decoder) incoming.pipe(decoder);
      };
      Promise.resolve().then(() => resolve4Impl(url.hostname)).then(addresses => {
        if (settled) return;
        if (!Array.isArray(addresses) || !addresses.length || !ipv4(addresses[0])) { fail(transportError("HTTPS_DNS_FAILED")); return; }
        const address = addresses[0];
        const lookup = (hostname, options, callback) => {
          if (typeof options === "function") { callback = options; options = {}; }
          if (hostname !== url.hostname) { callback(transportError("HTTPS_REQUEST_FAILED")); return; }
          if (options?.all) callback(null, [{ address, family: 4 }]); else callback(null, address, 4);
        };
        try {
          request = requestImpl({ protocol: "https:", hostname: url.hostname, port: url.port || 443,
            path: url.pathname + url.search, method, headers, servername: url.hostname, rejectUnauthorized: true,
            autoSelectFamily: false, family: 4, lookup, agent: false, maxHeaderSize: 64 * 1024 }, onResponse);
          request.on("error", () => fail(transportError("HTTPS_REQUEST_FAILED")));
          if (settled) { stop(request); return; }
          request.end(body === null ? undefined : body);
        } catch { fail(transportError("HTTPS_REQUEST_FAILED")); }
      }, () => fail(transportError("HTTPS_DNS_FAILED")));
    });
  };
}
module.exports = { createResolvedHttpsFetch, RESOLVED_HTTPS_POLICY };
