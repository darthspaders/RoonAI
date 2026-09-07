"use strict";

const fs = require("fs");
const path = require("path");
const { fetchWithTimeout } = require("./tidalRequestGuard");

const DEFAULT_BASE_URL = "https://api.beatport.com/v4";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_REQUESTS_PER_SECOND = 2;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 2000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const REFRESH_SKEW_MS = 90_000;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanUrl(value, fallback = DEFAULT_BASE_URL) {
  const text = cleanText(value || fallback).replace(/\/+$/, "");
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.toString().replace(/\/+$/, "") : DEFAULT_BASE_URL;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function cleanNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function firstText(...values) {
  for (const value of values.flat()) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function redactToken(value = "") {
  const text = cleanText(value);
  if (!text) return "";
  if (text.length <= 12) return "configured";
  return `${text.slice(0, 5)}...${text.slice(-5)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function responseHeader(response, name) {
  if (!response?.headers) return "";
  if (typeof response.headers.get === "function") return cleanText(response.headers.get(name));
  const lower = String(name).toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (String(key).toLowerCase() === lower) return cleanText(value);
  }
  return "";
}

function responseRateLimitHeaders(response) {
  const headers = {};
  if (!response?.headers) return headers;
  const visit = (key, value) => {
    const name = cleanText(key);
    if (/^(retry-after|x-.*rate.*limit.*|.*rate[-_]?limit.*)$/i.test(name)) {
      headers[name] = cleanText(value);
    }
  };
  if (typeof response.headers.forEach === "function") {
    response.headers.forEach((value, key) => visit(key, value));
  } else {
    for (const [key, value] of Object.entries(response.headers)) visit(key, value);
  }
  return headers;
}

function parseRetryAfterMs(value, now = Date.now()) {
  const text = cleanText(value);
  if (!text) return 0;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_BACKOFF_MS, seconds * 1000);
  const dateMs = Date.parse(text);
  if (Number.isFinite(dateMs)) return Math.min(MAX_BACKOFF_MS, Math.max(0, dateMs - now));
  return 0;
}

function objectName(value) {
  if (!value) return "";
  if (typeof value === "string") return cleanText(value);
  return firstText(value.name, value.title, value.display_name, value.attributes?.name, value.attributes?.title);
}

function objectListNames(value) {
  if (!Array.isArray(value)) return [];
  return value.map(objectName).filter(Boolean);
}

function objectListIds(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => firstText(item?.id, item?.artist_id, item?.uuid)).filter(Boolean);
}

function firstImageUrl(...values) {
  for (const value of values.flat()) {
    if (!value) continue;
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
    if (typeof value === "object") {
      const direct = firstText(value.url, value.uri, value.href);
      if (/^https?:\/\//i.test(direct)) return direct;
      const nested = firstImageUrl(value.image, value.large, value.medium, value.small);
      if (nested) return nested;
    }
  }
  return "";
}

function beatportTrackUrl(track = {}) {
  const id = firstText(track.id, track.track_id);
  const slug = firstText(track.slug, track.url_slug);
  if (!id || !slug) return "";
  return `https://www.beatport.com/track/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`;
}

function beatportTrackIdFromUrl(value = "") {
  const text = cleanText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    const parts = url.pathname.split("/").filter(Boolean);
    const trackIndex = parts.indexOf("track");
    const id = trackIndex >= 0 ? parts[trackIndex + 2] : "";
    return /^\d+$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

function normalizeBeatportTrack(raw = {}) {
  const attributes = raw.attributes && typeof raw.attributes === "object" ? raw.attributes : {};
  const track = { ...attributes, ...raw };
  const artists = objectListNames(track.artists);
  const remixers = objectListNames(track.remixers);
  const genre = objectName(track.genre);
  const subGenre = objectName(track.sub_genre || track.subGenre);
  const release = track.release && typeof track.release === "object" ? track.release : {};
  const label = objectName(release.label || track.label);
  const releaseDate = firstText(track.publish_date, track.new_release_date, track.release_date, track.date, release.publish_date, release.release_date);
  const title = firstText(track.name, track.title);
  const mixName = firstText(track.mix_name, track.mixName);
  const imageUrl = firstImageUrl(track.image, track.images, release.image, release.images);
  return {
    source: "beatport",
    id: firstText(track.id, track.track_id),
    title,
    mixName,
    artist: firstText(artists.join(", "), track.artist),
    artists: artists.map((name) => ({ name })),
    remixers: remixers.map((name) => ({ name })),
    album: firstText(release.name, release.title),
    label,
    releaseId: firstText(release.id, track.release_id),
    artistIds: objectListIds(track.artists),
    remixerIds: objectListIds(track.remixers),
    genre,
    subGenre,
    beatportTags: [genre, subGenre].filter(Boolean),
    bpm: cleanNumber(track.bpm),
    keyName: objectName(track.key),
    camelot: firstText(track.key?.camelot, track.camelot, track.key?.camelot_number && track.key?.camelot_letter ? `${track.key.camelot_number}${track.key.camelot_letter}` : ""),
    releaseDate,
    year: releaseDate,
    durationMs: cleanNumber(track.length_ms || track.duration_ms),
    isrc: firstText(track.isrc),
    imageUrl,
    beatportUrl: firstText(track.url, track.href, beatportTrackUrl(track)),
    rawJson: raw
  };
}

function extractBeatportTracks(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.tracks?.data,
    payload?.tracks?.results,
    payload?.tracks,
    payload?.results?.tracks,
    payload?.results,
    payload?.data
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeBeatportToken(token = {}, current = {}, now = Date.now()) {
  const expiresIn = Number(token.expires_in || token.expiresIn || 0);
  const expiresAtMs = Number(token.expiresAtMs || token.expires_at_ms || 0);
  return {
    ...current,
    accessToken: cleanText(token.access_token || token.accessToken || current.accessToken),
    refreshToken: cleanText(token.refresh_token || token.refreshToken || current.refreshToken),
    tokenType: cleanText(token.token_type || token.tokenType || current.tokenType || "Bearer"),
    scope: cleanText(token.scope || current.scope),
    expiresAtMs: expiresIn ? now + Math.max(60, expiresIn) * 1000 : expiresAtMs || Number(current.expiresAtMs || 0),
    updatedAt: new Date(now).toISOString()
  };
}

class BeatportRateLimiter {
  constructor({ requestsPerSecond = DEFAULT_REQUESTS_PER_SECOND, now = Date.now, sleepFn = sleep } = {}) {
    const rate = Number(requestsPerSecond);
    this.requestsPerSecond = Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_REQUESTS_PER_SECOND;
    this.minSpacingMs = Math.max(1, Math.ceil(1000 / this.requestsPerSecond));
    this.now = now;
    this.sleepFn = sleepFn;
    this.nextAvailableAt = 0;
    this.queue = Promise.resolve();
  }

  async waitTurn() {
    const run = this.queue.then(async () => {
      const current = Number(this.now());
      const delayMs = Math.max(0, this.nextAvailableAt - current);
      if (delayMs > 0) await this.sleepFn(delayMs);
      const afterWait = Number(this.now());
      this.nextAvailableAt = Math.max(afterWait, this.nextAvailableAt) + this.minSpacingMs;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

class BeatportTokenStore {
  constructor(file = path.join(__dirname, "..", "data", "beatport-token.json")) {
    this.file = file;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  save(token = {}) {
    const next = normalizeBeatportToken(token, this.read());
    ensureDir(this.file);
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  status() {
    const token = this.read();
    const now = Date.now();
    return {
      tokenFile: this.file,
      accessTokenStored: Boolean(token.accessToken),
      refreshTokenStored: Boolean(token.refreshToken),
      accessTokenPreview: redactToken(token.accessToken),
      expiresAt: token.expiresAtMs ? new Date(Number(token.expiresAtMs)).toISOString() : "",
      expiresInMs: token.expiresAtMs ? Math.max(0, Number(token.expiresAtMs) - now) : 0,
      scope: cleanText(token.scope),
      updatedAt: token.updatedAt || ""
    };
  }
}

class BeatportClient {
  constructor({
    enabled = false,
    clientId = "",
    accessToken = "",
    refreshToken = "",
    tokenFile = "",
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResults = DEFAULT_MAX_RESULTS,
    requestsPerSecond = DEFAULT_REQUESTS_PER_SECOND,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
    maxRetries = DEFAULT_MAX_RETRIES,
    sleepFn = sleep,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    logger = console
  } = {}) {
    this.enabled = enabled === true;
    this.clientId = cleanText(clientId);
    this.accessToken = cleanText(accessToken);
    this.refreshToken = cleanText(refreshToken);
    this.store = new BeatportTokenStore(tokenFile || undefined);
    this.baseUrl = cleanUrl(baseUrl);
    this.timeoutMs = Math.max(500, Math.min(30000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    this.maxResults = Math.max(1, Math.min(25, Number(maxResults) || DEFAULT_MAX_RESULTS));
    this.requestsPerSecond = Math.max(0.1, Math.min(10, Number(requestsPerSecond) || DEFAULT_REQUESTS_PER_SECOND));
    this.cacheTtlMs = Math.max(0, Number(cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
    this.maxCacheEntries = Math.max(0, Math.min(10000, Number(maxCacheEntries) || DEFAULT_MAX_CACHE_ENTRIES));
    this.maxRetries = Math.max(0, Math.min(5, Number(maxRetries) || DEFAULT_MAX_RETRIES));
    this.now = now;
    this.sleepFn = sleepFn;
    this.limiter = new BeatportRateLimiter({ requestsPerSecond: this.requestsPerSecond, now, sleepFn });
    this.cache = new Map();
    this.stats = {
      requestCount: 0,
      cacheHits: 0,
      status429Count: 0,
      retryAfterValues: [],
      rateLimitHeaders: {},
      firstRequestAt: 0,
      lastRequestAt: 0
    };
    this.fetchImpl = fetchImpl;
    this.logger = logger;
  }

  isConfigured() {
    const token = this.store.read();
    return this.enabled && Boolean(this.accessToken || token.accessToken || this.refreshToken || token.refreshToken);
  }

  status() {
    const store = this.store.status();
    return {
      enabled: this.enabled,
      configured: this.isConfigured(),
      hasClientId: Boolean(this.clientId),
      hasAccessToken: Boolean(this.accessToken || store.accessTokenStored),
      hasRefreshToken: Boolean(this.refreshToken || store.refreshTokenStored),
      baseUrl: this.baseUrl,
      maxResults: this.maxResults,
      throttle: {
        requestsPerSecond: this.requestsPerSecond,
        minSpacingMs: this.limiter.minSpacingMs
      },
      diagnostics: this.diagnostics(),
      ...store
    };
  }

  diagnostics() {
    const now = Number(this.now());
    const elapsedMs = this.stats.firstRequestAt ? Math.max(1, now - this.stats.firstRequestAt) : 0;
    const effectiveRequestRate = elapsedMs ? Number((this.stats.requestCount / (elapsedMs / 1000)).toFixed(3)) : 0;
    return {
      requestCount: this.stats.requestCount,
      cacheHits: this.stats.cacheHits,
      cacheEntries: this.cache.size,
      effectiveRequestRate,
      status429Count: this.stats.status429Count,
      retryAfterValues: [...this.stats.retryAfterValues],
      rateLimitHeaders: { ...this.stats.rateLimitHeaders },
      lastRequestAt: this.stats.lastRequestAt ? new Date(this.stats.lastRequestAt).toISOString() : ""
    };
  }

  cacheKey(url) {
    return cleanText(url);
  }

  getCachedJson(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs && entry.expiresAtMs <= Number(this.now())) {
      this.cache.delete(key);
      return null;
    }
    this.stats.cacheHits += 1;
    return entry.value;
  }

  setCachedJson(key, value) {
    if (!this.cacheTtlMs || !this.maxCacheEntries) return;
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, {
      value,
      expiresAtMs: Number(this.now()) + this.cacheTtlMs
    });
  }

  recordResponseDiagnostics(response) {
    const current = Number(this.now());
    this.stats.requestCount += 1;
    this.stats.firstRequestAt ||= current;
    this.stats.lastRequestAt = current;
    const headers = responseRateLimitHeaders(response);
    if (Object.keys(headers).length) {
      this.stats.rateLimitHeaders = {
        ...this.stats.rateLimitHeaders,
        ...headers
      };
      this.logger?.debug?.("Beatport rate-limit headers", headers);
    }
    if (response?.status === 429) {
      this.stats.status429Count += 1;
      const retryAfter = responseHeader(response, "retry-after");
      if (retryAfter) this.stats.retryAfterValues.push(retryAfter);
    }
  }

  backoffDelayMs(response, attempt) {
    const retryAfterMs = parseRetryAfterMs(responseHeader(response, "retry-after"), Number(this.now()));
    if (retryAfterMs > 0) return retryAfterMs;
    return Math.min(MAX_BACKOFF_MS, DEFAULT_BACKOFF_MS * Math.pow(2, attempt));
  }

  async requestRaw(url, options = {}, { label = "Beatport request", auth = true, cache = false } = {}) {
    const requestUrl = String(url);
    const method = cleanText(options.method || "GET").toUpperCase();
    const cacheKey = cache && method === "GET" ? this.cacheKey(requestUrl) : "";
    if (cacheKey) {
      const cached = this.getCachedJson(cacheKey);
      if (cached) return { ok: true, status: 200, cached: true, json: async () => cached };
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.limiter.waitTurn();
      const response = await fetchWithTimeout(requestUrl, {
        ...options,
        headers: {
          accept: "application/json",
          "user-agent": "RabbitHole/0.1.0",
          ...(options.headers || {})
        }
      }, {
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        label
      });
      this.recordResponseDiagnostics(response);
      if (response.ok) {
        if (cacheKey) {
          const json = await response.json().catch(() => null);
          if (json !== null) this.setCachedJson(cacheKey, json);
          return {
            ok: response.ok,
            status: response.status,
            headers: response.headers,
            cached: false,
            json: async () => json
          };
        }
        return response;
      }
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt >= this.maxRetries) return response;
      const delayMs = this.backoffDelayMs(response, attempt);
      this.logger?.debug?.("Beatport request retry scheduled", {
        status: response.status,
        delayMs,
        auth,
        attempt: attempt + 1
      });
      await this.sleepFn(delayMs);
    }
    return null;
  }

  async refreshAccessToken() {
    const token = this.store.read();
    const refreshToken = cleanText(token.refreshToken || this.refreshToken);
    if (!refreshToken || !this.clientId) return "";
    const response = await this.requestRaw(`${this.baseUrl}/auth/o/token/`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    }, {
      label: "Beatport token refresh",
      auth: false
    });
    if (!response) return "";
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.access_token) return "";
    const saved = this.store.save(json);
    this.accessToken = cleanText(saved.accessToken);
    this.refreshToken = cleanText(saved.refreshToken);
    return this.accessToken;
  }

  async getAccessToken() {
    if (!this.enabled) return "";
    const token = this.store.read();
    const accessToken = cleanText(token.accessToken || this.accessToken);
    const expiresAtMs = Number(token.expiresAtMs || 0);
    if (accessToken && (!expiresAtMs || expiresAtMs - Date.now() > REFRESH_SKEW_MS)) return accessToken;
    if (token.refreshToken || this.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) return refreshed;
    }
    return accessToken;
  }

  async requestJson(pathname, params = {}) {
    if (!this.isConfigured()) return null;
    const accessToken = await this.getAccessToken();
    if (!accessToken) return null;
    const url = new URL(`${this.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await this.requestRaw(url.toString(), {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    }, {
      label: "Beatport metadata lookup",
      auth: true,
      cache: true
    });
    if (!response) return null;
    if (response.status === 401 || response.status === 403 || response.status === 404) return null;
    if (!response.ok) {
      this.logger?.debug?.("Beatport metadata lookup returned HTTP error", { status: response.status });
      const error = new Error(`Beatport metadata lookup returned HTTP ${response.status}`);
      error.status = response.status;
      error.retryAfterMs = response.status === 429 ? this.backoffDelayMs(response, 0) : 0;
      throw error;
    }
    return response.json().catch(() => null);
  }

  async findTrack(track = {}) {
    const isrc = cleanText(track.isrc).replace(/[^a-z0-9]/gi, "").toUpperCase();
    if (isrc) {
      const byIsrc = await this.requestJson(`/catalog/tracks/store/${encodeURIComponent(isrc)}/`);
      const exact = extractBeatportTracks(byIsrc)[0] || byIsrc?.data || byIsrc;
      if (exact && typeof exact === "object") {
        const normalized = normalizeBeatportTrack(exact);
        if (normalized.title || normalized.artist) return normalized;
        const trackId = beatportTrackIdFromUrl(exact.store_url);
        if (trackId) {
          const detail = await this.requestJson(`/catalog/tracks/${encodeURIComponent(trackId)}/`);
          const detailNormalized = normalizeBeatportTrack(detail || {});
          if (detailNormalized.title || detailNormalized.artist) return detailNormalized;
        }
      }
    }

    const query = [track.artist, track.title].map(cleanText).filter(Boolean).join(" ");
    if (!query) return null;
    const payload = await this.requestJson("/catalog/search/", {
      q: query,
      type: "tracks",
      page: 1,
      per_page: this.maxResults
    });
    for (const candidate of extractBeatportTracks(payload).slice(0, this.maxResults)) {
      const normalized = normalizeBeatportTrack(candidate);
      if (normalized.title || normalized.artist) return normalized;
    }
    return null;
  }
}

module.exports = {
  BeatportClient,
  BeatportTokenStore,
  beatportTrackIdFromUrl,
  extractBeatportTracks,
  normalizeBeatportToken,
  normalizeBeatportTrack,
  parseRetryAfterMs,
  redactToken
};
