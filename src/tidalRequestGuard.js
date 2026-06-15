"use strict";

const DEFAULT_TIDAL_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_TIDAL_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_TIDAL_CIRCUIT_COOLDOWN_MS = 45_000;

function cleanErrorMessage(error) {
  return String(error?.message || error?.name || error || "unknown error").replace(/\s+/g, " ").trim();
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
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(error?.code)) return true;
  return /\b(?:timed out|timeout|fetch failed|network|socket hang up|connection reset)\b/i.test(cleanErrorMessage(error));
}

async function fetchWithTimeout(url, options = {}, {
  timeoutMs = DEFAULT_TIDAL_FETCH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  label = "TIDAL request"
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");

  const safeTimeoutMs = positiveNumber(timeoutMs, DEFAULT_TIDAL_FETCH_TIMEOUT_MS, { min: 250, max: 120_000 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw timeoutError(label, safeTimeoutMs);
    throw error;
  } finally {
    clearTimeout(timeout);
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
  positiveNumber
};
