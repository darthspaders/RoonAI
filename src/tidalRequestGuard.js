"use strict";

const dns = require("dns");
const http = require("http");
const https = require("https");

const DEFAULT_TIDAL_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_TIDAL_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_TIDAL_CIRCUIT_COOLDOWN_MS = 45_000;
const DEFAULT_TIDAL_DNS_RETRIES = 2;
const DNS_CACHE_TTL_MS = 5 * 60_000;
const DNS_STALE_CACHE_TTL_MS = 30 * 60_000;
const dnsCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanErrorMessage(error) {
  return String(error?.message || error?.name || error || "unknown error").replace(/\s+/g, " ").trim();
}

function fetchErrorCode(error) {
  return String(error?.code || error?.cause?.code || "").trim();
}

function decorateFetchError(error) {
  const code = fetchErrorCode(error);
  if (code && !error.code) error.code = code;
  if (error?.message === "fetch failed" && error?.cause?.message) {
    error.message = `${error.message}: ${error.cause.message}`;
  }
  return error;
}

function positiveNumber(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function timeoutError(label, timeoutMs) {
  const error = new Error(`${label || "TIDAL request"} timed out after ${Math.round(timeoutMs / 1000)}s`);
  error.name = "TimeoutError";
  error.code = "ETIMEDOUT";
  error.retryable = true;
  return error;
}

function httpStatusError(label, status) {
  const error = new Error(`${label || "TIDAL request"} failed: HTTP ${status}`);
  error.status = Number(status);
  error.retryable = error.status === 429 || error.status >= 500;
  return error;
}

function isRetryableCircuitError(error) {
  const status = Number(error?.status || 0);
  if (status === 429 || status >= 500) return true;
  if (error?.retryable) return true;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return true;
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(fetchErrorCode(error))) return true;
  return /\b(?:timed out|timeout|fetch failed|network|socket hang up|connection reset)\b/i.test(cleanErrorMessage(error));
}

function isTransientDnsError(error) {
  return ["EAI_AGAIN", "ENOTFOUND"].includes(fetchErrorCode(error));
}

function headerEntries(headers = {}) {
  if (!headers) return [];
  if (typeof headers.entries === "function") return Array.from(headers.entries());
  return Object.entries(headers);
}

function headerObject(headers = {}) {
  const result = {};
  for (const [key, value] of headerEntries(headers)) {
    if (!key || value === undefined || value === null) continue;
    result[String(key).toLowerCase()] = String(value);
  }
  return result;
}

function bodyBuffer(body) {
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  return Buffer.from(String(body));
}

function cachedDnsEntry(hostname) {
  const entry = dnsCache.get(hostname);
  if (!entry) return null;
  return Date.now() - entry.resolvedAtMs <= DNS_CACHE_TTL_MS ? entry : null;
}

function staleDnsEntry(hostname) {
  const entry = dnsCache.get(hostname);
  if (!entry) return null;
  return Date.now() - entry.resolvedAtMs <= DNS_STALE_CACHE_TTL_MS ? entry : null;
}

async function resolveHostname(hostname) {
  const cached = cachedDnsEntry(hostname);
  if (cached) return cached;

  try {
    const addresses = await dns.promises.resolve4(hostname);
    const address = addresses[0];
    if (address) {
      const entry = { address, family: 4, resolvedAtMs: Date.now() };
      dnsCache.set(hostname, entry);
      return entry;
    }
  } catch {
    // Fall through to OS lookup. If both fail, a stale cache entry can still keep TIDAL usable.
  }

  try {
    const result = await dns.promises.lookup(hostname, { family: 4 });
    if (result?.address) {
      const entry = { address: result.address, family: result.family || 4, resolvedAtMs: Date.now() };
      dnsCache.set(hostname, entry);
      return entry;
    }
  } catch (error) {
    const stale = staleDnsEntry(hostname);
    if (stale) return stale;
    throw error;
  }

  const error = new Error(`DNS lookup returned no address for ${hostname}`);
  error.code = "ENOTFOUND";
  throw error;
}

class BufferedResponse {
  constructor(status, headers, buffer) {
    this.status = Number(status || 0);
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = {
      get: (name) => headers[String(name || "").toLowerCase()] || null
    };
    this.buffer = buffer || Buffer.alloc(0);
  }

  async text() {
    return this.buffer.toString("utf8");
  }

  async json() {
    return JSON.parse(await this.text());
  }
}

async function nodeHttpFetchWithCachedDns(url, options = {}, redirectCount = 0) {
  const parsed = new URL(url);
  const transport = parsed.protocol === "http:" ? http : https;
  const headers = headerObject(options.headers);
  const payload = bodyBuffer(options.body);
  if (payload && !headers["content-length"]) headers["content-length"] = String(payload.length);

  const resolved = await resolveHostname(parsed.hostname);

  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method || (payload ? "POST" : "GET"),
      headers,
      lookup: (_hostname, lookupOptions, callback) => {
        const done = typeof lookupOptions === "function" ? lookupOptions : callback;
        if (lookupOptions?.all) {
          done(null, [{ address: resolved.address, family: resolved.family }]);
          return;
        }
        done(null, resolved.address, resolved.family);
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", async () => {
        const status = Number(response.statusCode || 0);
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && options.redirect !== "manual" && redirectCount < 3) {
          try {
            const nextUrl = new URL(location, parsed).toString();
            resolve(await nodeHttpFetchWithCachedDns(nextUrl, { ...options, body: undefined }, redirectCount + 1));
          } catch (error) {
            reject(error);
          }
          return;
        }
        resolve(new BufferedResponse(status, headerObject(response.headers), Buffer.concat(chunks)));
      });
    });

    const abort = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      request.destroy(error);
    };

    options.signal?.addEventListener("abort", abort, { once: true });
    request.on("error", (error) => {
      options.signal?.removeEventListener("abort", abort);
      reject(decorateFetchError(error));
    });
    request.on("close", () => options.signal?.removeEventListener("abort", abort));

    if (payload) request.write(payload);
    request.end();
  });
}

async function fetchWithTimeout(url, options = {}, {
  timeoutMs = DEFAULT_TIDAL_FETCH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  label = "TIDAL request",
  dnsRetries = DEFAULT_TIDAL_DNS_RETRIES
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");

  const safeTimeoutMs = positiveNumber(timeoutMs, DEFAULT_TIDAL_FETCH_TIMEOUT_MS, { min: 250, max: 120_000 });
  const safeDnsRetries = Math.max(0, Math.min(5, Number.isFinite(Number(dnsRetries)) ? Math.round(Number(dnsRetries)) : DEFAULT_TIDAL_DNS_RETRIES));

  for (let attempt = 0; attempt <= safeDnsRetries; attempt += 1) {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw timeoutError(label, safeTimeoutMs);
      const decorated = decorateFetchError(error);
      if (attempt < safeDnsRetries && isTransientDnsError(decorated)) {
        clearTimeout(timeout);
        await sleep(150 * (attempt + 1));
        continue;
      }
      if (isTransientDnsError(decorated)) {
        return await nodeHttpFetchWithCachedDns(url, { ...options, signal: controller.signal });
      }
      throw decorated;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", forwardAbort);
    }
  }
}

class CircuitBreaker {
  constructor({
    label = "TIDAL",
    failureThreshold = DEFAULT_TIDAL_CIRCUIT_FAILURE_THRESHOLD,
    cooldownMs = DEFAULT_TIDAL_CIRCUIT_COOLDOWN_MS,
    clock = () => Date.now()
  } = {}) {
    this.label = label;
    this.failureThreshold = positiveNumber(failureThreshold, DEFAULT_TIDAL_CIRCUIT_FAILURE_THRESHOLD, { min: 1, max: 20 });
    this.cooldownMs = positiveNumber(cooldownMs, DEFAULT_TIDAL_CIRCUIT_COOLDOWN_MS, { min: 1000, max: 10 * 60_000 });
    this.clock = clock;
    this.failureCount = 0;
    this.openUntilMs = 0;
    this.lastError = "";
  }

  state() {
    const now = this.clock();
    if (this.openUntilMs > now) return "open";
    if (this.openUntilMs && this.failureCount >= this.failureThreshold) return "half-open";
    return "closed";
  }

  assertCanRequest() {
    const state = this.state();
    if (state !== "open") return;

    const retryAfterMs = Math.max(0, this.openUntilMs - this.clock());
    const error = new Error(`${this.label} temporarily unavailable after repeated fetch failures; retry in ${Math.ceil(retryAfterMs / 1000)}s.`);
    error.code = "ECIRCUITOPEN";
    error.retryAfterMs = retryAfterMs;
    error.retryable = true;
    throw error;
  }

  recordSuccess() {
    this.failureCount = 0;
    this.openUntilMs = 0;
    this.lastError = "";
  }

  recordFailure(error) {
    if (!isRetryableCircuitError(error)) return;
    this.failureCount += 1;
    this.lastError = cleanErrorMessage(error);
    if (this.failureCount >= this.failureThreshold) {
      this.openUntilMs = this.clock() + this.cooldownMs;
    }
  }

  status() {
    const retryAfterMs = this.state() === "open" ? Math.max(0, this.openUntilMs - this.clock()) : 0;
    return {
      state: this.state(),
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      retryAfterMs,
      lastError: this.lastError
    };
  }
}

module.exports = {
  CircuitBreaker,
  DEFAULT_TIDAL_CIRCUIT_COOLDOWN_MS,
  DEFAULT_TIDAL_CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_TIDAL_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  httpStatusError,
  isRetryableCircuitError,
  isTransientDnsError,
  positiveNumber
};
