"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fetchWithTimeout } = require("./tidalRequestGuard");
const { DiscogsOAuth } = require("./discogsOAuth");

const DEFAULT_BASE_URL = "https://api.discogs.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_RELEASE_LOOKUPS = 5;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanIsrc(value) {
  return cleanText(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function splitCredits(value) {
  return Array.from(new Set(cleanText(value)
    .split(/\s+(?:and|feat\.?|featuring|with|vs\.?|versus)\s+|[,/&+|]+/i)
    .map(normalizeText)
    .filter((part) => part && part.length > 1)));
}

function artistNames(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item?.name || item?.anv || item)).filter(Boolean);
}

function artistCreditMatches(expected, actual) {
  const expectedParts = splitCredits(expected);
  const actualParts = splitCredits(actual);
  if (!expectedParts.length || !actualParts.length) return false;
  return expectedParts.every((wanted) => actualParts.some((candidate) => (
    wanted === candidate || wanted.includes(candidate) || candidate.includes(wanted)
  )));
}

function stripVersion(value) {
  return normalizeText(value)
    .replace(/\b(?:original|extended|radio|club|instrumental|acoustic|live|remastered?|vip|dub|edit|mix|version|remix)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleMatchType(expected, actual) {
  const left = normalizeText(expected);
  const right = normalizeText(actual);
  if (!left || !right) return "";
  if (left === right) return "EXACT_TITLE";
  if (stripVersion(left) && stripVersion(left) === stripVersion(right)) return "RELATED_VERSION";
  return "";
}

function durationMs(value) {
  const text = cleanText(value);
  if (!text) return null;
  const parts = text.split(":").map((part) => Number(part));
  if (parts.length === 2 && parts.every((part) => Number.isFinite(part))) {
    return Math.round((parts[0] * 60 + parts[1]) * 1000);
  }
  if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) {
    return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric < 10_000 ? numeric * 1000 : numeric) : null;
}

function firstYear(...values) {
  for (const value of values.flat()) {
    const match = cleanText(value).match(/\b((?:19|20)\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return null;
}

function jsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function jsonStringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

function releaseSearchKey(track = {}) {
  const artist = normalizeText(track.artist);
  const title = normalizeText(track.title);
  const album = normalizeText(track.album || track.releaseTitle);
  return artist && title ? `${artist}|${title}|${album}` : "";
}

function releaseUrl(id, uri = "") {
  const direct = cleanText(uri);
  if (/^https?:\/\//i.test(direct)) return direct;
  return id ? `https://www.discogs.com/release/${encodeURIComponent(id)}` : "";
}

function responseHeader(response, name) {
  if (!response?.headers) return "";
  if (typeof response.headers.get === "function") return cleanText(response.headers.get(name));
  const wanted = String(name).toLowerCase();
  return Object.entries(response.headers).find(([key]) => String(key).toLowerCase() === wanted)?.[1] || "";
}

function releaseIdentifiers(release = {}, track = {}) {
  // Discogs can expose identifiers at release level, but a release-level
  // ISRC is not safe to attribute to an individual track. Only use the
  // track-level identifier when building per-track evidence.
  for (const item of Array.isArray(track.identifiers) ? track.identifiers : []) {
    if (/^isrc$/i.test(cleanText(item?.type))) {
      const value = cleanIsrc(item.value);
      if (value) return value;
    }
  }
  return "";
}

function releaseTrackCandidate(release = {}, requested = {}) {
  const releaseArtists = artistNames(release.artists);
  const releaseArtistText = releaseArtists.join(", ");
  const tracklist = Array.isArray(release.tracklist) ? release.tracklist : [];
  const wantedIsrc = cleanIsrc(requested.isrc);
  const possible = [];

  for (const item of tracklist) {
    const title = cleanText(item?.title || item?.name);
    if (!title) continue;
    const trackArtists = artistNames(item?.artists);
    const artistText = trackArtists.length ? trackArtists.join(", ") : releaseArtistText;
    const titleType = titleMatchType(requested.title, title);
    if (!titleType || !artistCreditMatches(requested.artist, artistText)) continue;
    const itemIsrc = releaseIdentifiers(release, item);
    const isrcMatch = Boolean(wantedIsrc && itemIsrc && wantedIsrc === itemIsrc);
    const albumMatch = normalizeText(requested.album || requested.releaseTitle) === normalizeText(release.title);
    let score = titleType === "EXACT_TITLE" ? 72 : 62;
    score += 18;
    if (isrcMatch) score += 10;
    if (albumMatch) score += 5;
    if (requested.year && firstYear(requested.year, requested.releaseDate) === firstYear(release.year, release.released)) score += 2;
    possible.push({
      score,
      title,
      artist: artistText,
      position: cleanText(item.position),
      durationMs: durationMs(item.duration),
      isrc: itemIsrc,
      titleType,
      isrcMatch
    });
  }

  const bestTrack = possible.sort((left, right) => right.score - left.score)[0];
  if (!bestTrack) return null;

  const labels = Array.isArray(release.labels) ? release.labels : [];
  const labelNames = labels.map((label) => cleanText(label?.name)).filter(Boolean);
  const catalogNumbers = labels.map((label) => cleanText(label?.catno)).filter(Boolean);
  const genres = Array.isArray(release.genres) ? release.genres.map(cleanText).filter(Boolean) : [];
  const styles = Array.isArray(release.styles) ? release.styles.map(cleanText).filter(Boolean) : [];
  const releaseId = cleanText(release.id);
  const masterId = cleanText(release.master_id || release.masterId);
  const providerTrackId = releaseId
    ? `${releaseId}:${bestTrack.position || normalizeText(bestTrack.title)}`
    : "";

  return {
    source: "discogs",
    id: providerTrackId,
    discogsId: releaseId,
    releaseId,
    masterId,
    title: bestTrack.title,
    artist: bestTrack.artist,
    album: cleanText(release.title),
    releaseTitle: cleanText(release.title),
    albumArtist: releaseArtistText,
    label: labelNames.join(", "),
    catalogNumber: catalogNumbers.join(", "),
    genre: genres.join(", "),
    subgenre: styles.join(", "),
    tags: [...genres, ...styles],
    releaseDate: cleanText(release.released),
    year: firstYear(release.year, release.released),
    durationMs: bestTrack.durationMs,
    isrc: bestTrack.isrc,
    position: bestTrack.position,
    confidence: Math.min(99, Math.round(bestTrack.score)),
    matchType: bestTrack.titleType === "RELATED_VERSION" ? "RELATED_VERSION" : "HIGH_CONFIDENCE",
    discogsUrl: releaseUrl(releaseId, release.uri),
    url: releaseUrl(releaseId, release.uri),
    rawJson: release,
    matchDiagnostics: {
      releaseId,
      masterId,
      trackPosition: bestTrack.position,
      titleType: bestTrack.titleType,
      isrcMatch: bestTrack.isrcMatch,
      releaseArtistText,
      labelNames,
      catalogNumbers
    }
  };
}

class DiscogsClient {
  constructor({
    enabled = true,
    token = "",
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResults = DEFAULT_MAX_RESULTS,
    maxReleaseLookups = DEFAULT_MAX_RELEASE_LOOKUPS,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    cacheFile = path.join(__dirname, "..", "data", "discogs-metadata-cache.json"),
    userAgent = "RabbitHole/0.1.0 (local metadata enrichment)",
    oauth = null,
    fetchImpl = globalThis.fetch,
    logger = console,
    clock = Date.now
  } = {}) {
    this.enabled = enabled !== false;
    this.token = cleanText(token);
    this.baseUrl = cleanText(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.maxResults = Math.max(1, Math.min(20, Number(maxResults) || DEFAULT_MAX_RESULTS));
    this.maxReleaseLookups = Math.max(1, Math.min(20, Number(maxReleaseLookups) || DEFAULT_MAX_RELEASE_LOOKUPS));
    const parsedIntervalMs = Number(minIntervalMs);
    this.minIntervalMs = Math.max(0, Number.isFinite(parsedIntervalMs) ? parsedIntervalMs : DEFAULT_MIN_INTERVAL_MS);
    this.cacheTtlMs = Math.max(60_000, Number(cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
    this.cacheFile = cacheFile;
    this.userAgent = cleanText(userAgent) || "RabbitHole/0.1.0";
    this.oauth = oauth || null;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : Date.now;
    this.cache = new Map();
    this.lastRequestAt = 0;
    this.requestChain = Promise.resolve();
    this.load();
  }

  isConfigured() {
    return this.enabled && Boolean(this.token || this.oauth?.isConfigured?.());
  }

  load() {
    if (!this.cacheFile) return;
    try {
      const payload = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
      if (payload?.version !== CACHE_VERSION || !Array.isArray(payload.entries)) return;
      this.cache = new Map(payload.entries
        .filter((entry) => entry?.key)
        .map((entry) => [entry.key, entry]));
    } catch {
      this.cache = new Map();
    }
  }

  save() {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        version: CACHE_VERSION,
        updatedAt: new Date(Number(this.clock())).toISOString(),
        entries: [...this.cache.values()]
      }, null, 2), "utf8");
      fs.renameSync(tmp, this.cacheFile);
    } catch (error) {
      this.logger?.debug?.("Discogs metadata cache could not be saved", { error: error.message });
    }
  }

  status() {
    return {
      enabled: this.enabled,
      configured: this.isConfigured(),
      baseUrl: this.baseUrl,
      cacheSize: this.cache.size,
      maxResults: this.maxResults,
      maxReleaseLookups: this.maxReleaseLookups,
      minIntervalMs: this.minIntervalMs,
      cacheTtlMs: this.cacheTtlMs,
      userAgent: this.userAgent,
      oauth: this.oauth?.status?.() || null
    };
  }

  async waitForSlot() {
    const run = this.requestChain.then(async () => {
      const waitMs = Math.max(0, this.minIntervalMs - (Number(this.clock()) - this.lastRequestAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.lastRequestAt = Number(this.clock());
    });
    this.requestChain = run.catch(() => {});
    await run;
  }

  async requestJson(url) {
    if (!this.isConfigured()) return null;
    await this.waitForSlot();
    const oauthHeaders = this.oauth?.isConfigured?.() ? this.oauth.authHeaders() : {};
    const response = await fetchWithTimeout(url, {
      headers: {
        accept: "application/json",
        "user-agent": this.userAgent,
        ...(Object.keys(oauthHeaders).length
          ? oauthHeaders
          : { authorization: `Discogs token=${this.token}` })
      }
    }, {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      label: "Discogs metadata lookup"
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const error = new Error(`Discogs metadata lookup failed: HTTP ${response.status}`);
      error.status = Number(response.status);
      error.retryAfter = responseHeader(response, "retry-after");
      throw error;
    }
    return response.json();
  }

  searchUrls(track = {}) {
    const artist = cleanText(track.artist);
    const title = cleanText(track.title);
    const album = cleanText(track.album || track.releaseTitle);
    const queries = [];
    const structured = new URL(`${this.baseUrl}/database/search`);
    structured.searchParams.set("type", "release");
    structured.searchParams.set("artist", artist);
    structured.searchParams.set("track", title);
    if (album) structured.searchParams.set("release_title", album);
    structured.searchParams.set("per_page", String(this.maxResults));
    queries.push(structured.toString());

    const broad = new URL(`${this.baseUrl}/database/search`);
    broad.searchParams.set("type", "release");
    broad.searchParams.set("q", `${artist} ${title}`.trim());
    broad.searchParams.set("per_page", String(this.maxResults));
    queries.push(broad.toString());
    return queries;
  }

  async findTrack(track = {}) {
    const key = releaseSearchKey(track);
    if (!key || !this.isConfigured()) return null;
    const cached = this.cache.get(key);
    if (cached && Number(this.clock()) - Number(cached.savedAt || 0) < this.cacheTtlMs) return cached.result || null;

    const searchResults = new Map();
    try {
      for (const url of this.searchUrls(track)) {
        const payload = await this.requestJson(url);
        for (const result of Array.isArray(payload?.results) ? payload.results : []) {
          const id = cleanText(result?.id);
          if (id && !searchResults.has(id)) searchResults.set(id, result);
        }
        if (searchResults.size >= this.maxReleaseLookups) break;
      }

      const candidates = [];
      for (const result of [...searchResults.values()].slice(0, this.maxReleaseLookups)) {
        const id = cleanText(result.id);
        if (!id) continue;
        const release = await this.requestJson(`${this.baseUrl}/releases/${encodeURIComponent(id)}`);
        const candidate = releaseTrackCandidate(release, track);
        if (candidate) candidates.push(candidate);
      }
      const best = candidates.sort((left, right) => right.confidence - left.confidence)[0] || null;
      this.cache.set(key, { key, savedAt: Number(this.clock()), result: best });
      this.save();
      return best;
    } catch (error) {
      this.logger?.debug?.("Discogs metadata lookup failed", { error: error.message, key });
      throw error;
    }
  }
}

module.exports = {
  DiscogsClient,
  DEFAULT_BASE_URL,
  artistCreditMatches,
  durationMs,
  normalizeText,
  releaseSearchKey,
  releaseTrackCandidate,
  stripVersion
};
