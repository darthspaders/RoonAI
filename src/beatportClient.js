"use strict";

const fs = require("fs");
const path = require("path");
const { fetchWithTimeout } = require("./tidalRequestGuard");

const DEFAULT_BASE_URL = "https://api.beatport.com/v4";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_REQUESTS_PER_SECOND = 2;
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
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
  const imageUrl = firstImageUrl(release.image, release.images, track.image, track.images);
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

function normalizeBeatportChart(raw = {}) {
  return {
    source: "beatport",
    kind: firstText(raw.kind) || "chart",
    id: firstText(raw.id),
    title: firstText(raw.name, raw.title),
    slug: firstText(raw.slug),
    description: firstText(raw.description),
    curator: firstText(raw.person?.owner_name, raw.artist?.name),
    curatorId: firstText(raw.person?.id, raw.artist?.id),
    addDate: firstText(raw.add_date),
    publishDate: firstText(raw.publish_date),
    changeDate: firstText(raw.change_date),
    trackCount: cleanNumber(raw.track_count) || 0,
    genres: Array.isArray(raw.genres) ? raw.genres.map(objectName).filter(Boolean) : [],
    imageUrl: firstImageUrl(raw.image),
    price: raw.price || null,
    rawJson: raw
  };
}

function normalizeBeatportRelease(raw = {}) {
  const label = objectName(raw.label);
  const genres = Array.isArray(raw.genres) ? raw.genres.map(objectName).filter(Boolean) : [];
  return {
    source: "beatport",
    kind: "release",
    id: firstText(raw.id),
    title: firstText(raw.name, raw.title),
    slug: firstText(raw.slug),
    description: firstText(raw.description),
    curator: label,
    curatorId: firstText(raw.label?.id),
    addDate: firstText(raw.created, raw.encoded_date),
    publishDate: firstText(raw.publish_date, raw.release_date, raw.new_release_date),
    changeDate: firstText(raw.updated, raw.change_date),
    trackCount: cleanNumber(raw.track_count || raw.tracks_count || raw.track_count_total) || 0,
    genres,
    imageUrl: firstImageUrl(raw.image, raw.images),
    price: raw.price || null,
    label,
    rawJson: raw
  };
}

function extractBeatportCharts(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.charts?.data,
    payload?.charts?.results,
    payload?.charts,
    payload?.results?.charts,
    payload?.results,
    payload?.data
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function extractBeatportReleases(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.releases?.data,
    payload?.releases?.results,
    payload?.releases,
    payload?.results?.releases,
    payload?.results,
    payload?.data
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function feedCollection({ id, title, trackCount = 100, description = "", imageUrl = "", source = "beatport" } = {}) {
  return {
    source: "beatport",
    kind: "track_feed",
    id,
    title,
    slug: id,
    description,
    curator: source,
    curatorId: "",
    addDate: "",
    publishDate: "",
    changeDate: "",
    trackCount,
    genres: ["Progressive House"],
    imageUrl,
    price: null,
    rawJson: null
  };
}

const PROGRESSIVE_EDITORIAL_QUERIES = {
  staff_picks: "staff picks progressive house",
  best_curation: "curation best progressive house",
  shortlists: "progressive house shortlist",
  after_hours: "after hours essentials progressive house",
  closing_essentials: "closing essentials progressive house",
  crate_diggers: "crate diggers progressive house",
  dancefloor_essentials: "dancefloor essentials progressive house",
  festival_essentials: "festival essentials progressive house",
  in_the_remix: "in the remix progressive house",
  on_our_radar: "on our radar progressive house",
  secret_weapons: "secret weapons progressive house",
  warm_up_essentials: "warm-up essentials progressive house"
};

function progressiveChartSort(a, b) {
  const bTime = Date.parse(b.publishDate || b.addDate || "") || 0;
  const aTime = Date.parse(a.publishDate || a.addDate || "") || 0;
  return bTime - aTime;
}

function chartLooksProgressive(chart = {}) {
  const haystack = [chart.title, chart.slug, ...(chart.genres || [])].join(" ").toLowerCase();
  return haystack.includes("progressive");
}

function chartHaystack(chart = {}) {
  return [chart.title, chart.slug, chart.curator, ...(chart.genres || [])].join(" ").toLowerCase();
}

function normalizedChartTrack(raw = {}, index = 0) {
  const track = normalizeBeatportTrack(raw);
  const titleWithMix = track.mixName && !new RegExp(`\\b${track.mixName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(track.title)
    ? `${track.title} (${track.mixName})`
    : track.title;
  return {
    ...track,
    position: index + 1,
    titleWithMix,
    source: "beatport_chart",
    metadataEnrichment: {
      source: "beatport",
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      label: track.label,
      genre: [track.genre, track.subGenre].filter(Boolean).join(", "),
      beatportTags: track.beatportTags,
      bpm: track.bpm,
      keyName: track.keyName,
      camelot: track.camelot,
      releaseDate: track.releaseDate,
      durationMs: track.durationMs,
      isrc: track.isrc,
      imageUrl: track.imageUrl,
      beatportUrl: track.beatportUrl,
      beatport: {
        id: track.id,
        url: track.beatportUrl,
        genre: track.genre,
        subGenre: track.subGenre,
        label: track.label,
        releaseDate: track.releaseDate,
        releaseId: track.releaseId,
        artistIds: track.artistIds,
        remixerIds: track.remixerIds,
        durationMs: track.durationMs,
        bpm: track.bpm,
        keyName: track.keyName,
        camelot: track.camelot,
        isrc: track.isrc
      }
    },
    beatport: {
      id: track.id,
      url: track.beatportUrl,
      genre: track.genre,
      subGenre: track.subGenre,
      label: track.label,
      releaseDate: track.releaseDate,
      releaseId: track.releaseId,
      bpm: track.bpm,
      keyName: track.keyName,
      camelot: track.camelot,
      isrc: track.isrc
    },
    tidal: {},
    tidalId: "",
    tidalUrl: "",
    url: track.beatportUrl
  };
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

  async getCharts({ genreId = 15, page = 1, perPage = 50, source = "genre", query = "" } = {}) {
    const normalizedPerPage = Math.max(1, Math.min(100, Number(perPage) || 50));
    const normalizedPage = Math.max(1, Number(page) || 1);
    const normalizedSource = cleanText(source).toLowerCase().replace(/-/g, "_");
    const editorialQuery = PROGRESSIVE_EDITORIAL_QUERIES[normalizedSource] || "";
    const params = {
      page: normalizedPage,
      per_page: normalizedPerPage
    };
    const cleanGenreId = cleanText(genreId).replace(/[^0-9]/g, "");
    let payload = null;
    let charts = [];
    if (normalizedSource === "top_tracks") {
      charts = [feedCollection({
        id: "tracks:top",
        title: "Top 100 Progressive House Tracks",
        description: "Current Beatport Progressive House track feed",
        trackCount: 100,
        source: "Beatport"
      })];
    } else if (normalizedSource === "hype_tracks") {
      charts = [feedCollection({
        id: "tracks:hype",
        title: "Hype Progressive House Tracks",
        description: "Current Beatport Hype Progressive House track feed",
        trackCount: 100,
        source: "Beatport Hype"
      })];
    } else if (normalizedSource === "releases" || normalizedSource === "hype_releases") {
      if (cleanGenreId) params.genre_id = cleanGenreId;
      if (normalizedSource === "hype_releases") params.is_hype = true;
      payload = await this.requestJson("/catalog/releases/", params);
      charts = extractBeatportReleases(payload).map((release) => {
        const normalized = normalizeBeatportRelease(release);
        return {
          ...normalized,
          id: `release:${normalized.id}`,
          sourceId: normalized.id
        };
      });
    } else if (editorialQuery) {
      payload = await this.requestJson("/catalog/search/", {
        ...params,
        q: cleanText(query) || editorialQuery
      });
      charts = extractBeatportCharts(payload)
        .map(normalizeBeatportChart)
        .filter(chartLooksProgressive)
        .filter((chart) => normalizedSource !== "staff_picks" || chartHaystack(chart).includes("staff"))
        .sort(progressiveChartSort);
    } else {
      if (cleanGenreId) params.genre_id = cleanGenreId;
      payload = await this.requestJson("/catalog/charts/", params);
      charts = extractBeatportCharts(payload).map(normalizeBeatportChart);
    }
    return {
      charts,
      pagination: {
        count: Number(payload?.count || charts.length) || charts.length,
        page: cleanText(payload?.page),
        perPage: Number(payload?.per_page || normalizedPerPage) || normalizedPerPage,
        next: cleanText(payload?.next),
        previous: cleanText(payload?.previous),
        source: normalizedSource
      },
      diagnostics: this.diagnostics()
    };
  }

  async pagedTracks(pathname, { page = 1, perPage = 100, params = {}, maxPages = 100 } = {}) {
    const normalizedPerPage = Math.max(1, Math.min(100, Number(perPage) || 100));
    let currentPage = Math.max(1, Number(page) || 1);
    const tracks = [];
    const pages = [];
    let next = "";
    do {
      const payload = await this.requestJson(pathname, {
        ...params,
        page: currentPage,
        per_page: normalizedPerPage
      });
      if (!payload) break;
      const pageTracks = extractBeatportTracks(payload);
      const start = tracks.length;
      tracks.push(...pageTracks.map((track, index) => normalizedChartTrack(track, start + index)));
      pages.push({
        page: cleanText(payload.page),
        perPage: Number(payload.per_page || normalizedPerPage) || normalizedPerPage,
        count: Number(payload.count || 0) || 0,
        next: cleanText(payload.next),
        previous: cleanText(payload.previous),
        retrieved: pageTracks.length
      });
      next = cleanText(payload.next);
      currentPage += 1;
    } while (next && pages.length < Math.max(1, Number(maxPages) || 1) && currentPage < 100);
    return { tracks, pages, next };
  }

  async getTrackFeed(feedId, { page = 1, perPage = 100, genreId = 15 } = {}) {
    const id = cleanText(feedId).toLowerCase();
    const isHype = id === "tracks:hype" || id === "hype";
    const cleanGenreId = cleanText(genreId).replace(/[^0-9]/g, "") || "15";
    const params = { genre_id: cleanGenreId };
    if (isHype) params.is_hype = true;
    const { tracks, pages, next } = await this.pagedTracks("/catalog/tracks/", { page, perPage, params, maxPages: 1 });
    return {
      chart: feedCollection({
        id: isHype ? "tracks:hype" : "tracks:top",
        title: isHype ? "Hype Progressive House Tracks" : "Top 100 Progressive House Tracks",
        trackCount: pages[0]?.count || tracks.length,
        source: isHype ? "Beatport Hype" : "Beatport"
      }),
      pagination: {
        count: pages[0]?.count || tracks.length,
        pageCount: pages.length,
        complete: !next,
        next,
        pages
      },
      tracks,
      diagnostics: this.diagnostics()
    };
  }

  async getRelease(releaseId, { page = 1, perPage = 100 } = {}) {
    const id = cleanText(releaseId).replace(/[^0-9]/g, "");
    if (!id) throw new Error("Beatport release ID is required.");
    const release = await this.requestJson(`/catalog/releases/${encodeURIComponent(id)}/`);
    if (!release) return null;
    const { tracks, pages, next } = await this.pagedTracks(`/catalog/releases/${encodeURIComponent(id)}/tracks/`, { page, perPage });
    return {
      chart: {
        ...normalizeBeatportRelease(release),
        id: `release:${id}`,
        sourceId: id
      },
      pagination: {
        count: pages[0]?.count || tracks.length,
        pageCount: pages.length,
        complete: !next,
        next,
        pages
      },
      tracks,
      diagnostics: this.diagnostics()
    };
  }

  async getChart(chartId, { page = 1, perPage = 100, resolveMissingArtwork = true } = {}) {
    const requestedId = cleanText(chartId);
    if (/^tracks:(?:top|hype)$/i.test(requestedId)) return this.getTrackFeed(requestedId, { page, perPage });
    if (/^release:\d+$/i.test(requestedId)) return this.getRelease(requestedId.split(":").pop(), { page, perPage });
    const id = requestedId.replace(/[^0-9]/g, "");
    if (!id) throw new Error("Beatport chart ID is required.");
    const chart = await this.requestJson(`/catalog/charts/${encodeURIComponent(id)}/`);
    if (!chart) return null;

    const { tracks, pages, next } = await this.pagedTracks(`/catalog/charts/${encodeURIComponent(id)}/tracks/`, { page, perPage });

    if (resolveMissingArtwork) {
      for (const track of tracks) {
        if (track.imageUrl || !track.id) continue;
        const detail = await this.requestJson(`/catalog/tracks/${encodeURIComponent(track.id)}/`);
        const normalized = normalizeBeatportTrack(detail || {});
        if (!normalized.imageUrl) continue;
        track.imageUrl = normalized.imageUrl;
        track.metadataEnrichment.imageUrl = normalized.imageUrl;
        track.metadataEnrichment.beatport.imageUrl = normalized.imageUrl;
        track.beatport.imageUrl = normalized.imageUrl;
      }
    }

    return {
      chart: normalizeBeatportChart(chart),
      pagination: {
        count: pages[0]?.count || tracks.length,
        pageCount: pages.length,
        complete: !next,
        next,
        pages
      },
      tracks,
      diagnostics: this.diagnostics()
    };
  }
}

module.exports = {
  BeatportClient,
  BeatportTokenStore,
  beatportTrackIdFromUrl,
  extractBeatportCharts,
  extractBeatportTracks,
  normalizeBeatportChart,
  normalizeBeatportToken,
  normalizeBeatportTrack,
  parseRetryAfterMs,
  redactToken
};
