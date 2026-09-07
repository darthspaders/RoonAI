"use strict";

const fs = require("fs");
const path = require("path");
const { chooseCoverImage, chooseRelease } = require("./radioMetadataResolver");
const { fetchWithTimeout } = require("./tidalRequestGuard");

const DEFAULT_MIN_CONFIDENCE = 80;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MISS_RETRY_MS = 2 * 60 * 1000;
const DEFAULT_MAX_MISS_RETRY_MS = 6 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

const STRIPPABLE_PARENTHETICALS = new Set([
  "remix",
  "original mix",
  "extended mix",
  "extended",
  "radio edit",
  "edit",
  "mix cut",
  "remastered",
  "remaster"
]);

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function stripSearchVersionTerms(value) {
  return cleanText(value)
    .replace(/\s*\[[^\]]*]\s*/g, " ")
    .replace(/\s*\(([^)]*)\)\s*/g, (match, inner) => {
      const normalized = normalizeText(inner);
      return STRIPPABLE_PARENTHETICALS.has(normalized) ? " " : match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCacheTitle(value) {
  return normalizeText(stripSearchVersionTerms(value));
}

function metadataCacheKey(track = {}) {
  const artist = normalizeText(track.artist);
  const title = normalizeCacheTitle(track.title);
  return artist && title ? `${artist}|${title}` : "";
}

function splitArtists(value) {
  return cleanText(value)
    .split(/\s+(?:and|feat\.?|featuring|with|vs\.?|versus)\s+|[,/&+|]+/i)
    .map(normalizeText)
    .filter((part) => part && part.length > 1);
}

function resultArtistNames(result = {}) {
  const names = [];
  if (result.artist) names.push(result.artist);
  if (Array.isArray(result.artists)) {
    for (const artist of result.artists) names.push(artist?.name || artist?.attributes?.name || artist);
  }
  if (Array.isArray(result.artistCredit)) {
    for (const credit of result.artistCredit) names.push(credit?.artist?.name || credit?.name || credit);
  }
  return names.map(cleanText).filter(Boolean).join(", ");
}

function exactArtistMatches(track = {}, result = {}) {
  const expected = splitArtists(track.artist);
  const actual = splitArtists(resultArtistNames(result));
  if (!expected.length || !actual.length) return false;
  return expected.some((left) => actual.some((right) => left === right));
}

function boundedEditDistance(left, right, maxDistance) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length];
}

function titlesAreFuzzyClose(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 8 && b.length >= 8 && (a.includes(b) || b.includes(a))) return true;
  const maxLength = Math.max(a.length, b.length);
  const maxDistance = maxLength >= 18 ? 3 : 2;
  return boundedEditDistance(a, b, maxDistance) <= maxDistance;
}

function cleanIsrc(value) {
  return cleanText(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function confidenceForMatch(track = {}, result = {}) {
  const trackIsrc = cleanIsrc(track.isrc);
  const resultIsrc = cleanIsrc(result.isrc);
  if (trackIsrc && resultIsrc && trackIsrc === resultIsrc) return {
    confidence: 100,
    reason: "ISRC match"
  };

  if (!exactArtistMatches(track, result)) return {
    confidence: 0,
    reason: "artist mismatch"
  };

  const wantedTitle = normalizeText(track.title);
  const resultTitle = normalizeText(result.title);
  if (wantedTitle && resultTitle && wantedTitle === resultTitle) return {
    confidence: 99,
    reason: "exact artist and title"
  };

  const wantedNormalized = normalizeCacheTitle(track.title);
  const resultNormalized = normalizeCacheTitle(result.title);
  if (wantedNormalized && resultNormalized && wantedNormalized === resultNormalized) return {
    confidence: 95,
    reason: "exact artist and normalized title"
  };

  if (titlesAreFuzzyClose(stripSearchVersionTerms(track.title), stripSearchVersionTerms(result.title))) {
    return {
      confidence: 85,
      reason: "exact artist and fuzzy title"
    };
  }

  return {
    confidence: 0,
    reason: "title mismatch"
  };
}

function firstYear(...values) {
  for (const value of values.flat()) {
    const match = cleanText(value).match(/\b(19\d{2}|20\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return null;
}

function firstText(...values) {
  for (const value of values.flat()) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function firstDurationMs(...values) {
  for (const value of values.flat()) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value > 1000 ? Math.round(value) : Math.round(value * 1000);
    }
    const text = cleanText(value);
    if (!text) continue;
    const iso = text.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (iso) return ((Number(iso[1] || 0) * 3600) + (Number(iso[2] || 0) * 60) + Number(iso[3] || 0)) * 1000;
    if (/^\d+$/.test(text)) {
      const number = Number(text);
      if (number > 0) return number > 1000 ? number : number * 1000;
    }
  }
  return null;
}

function normalizeGenre(value) {
  if (Array.isArray(value)) return value.map(normalizeGenre).filter(Boolean).join(", ");
  if (typeof value === "object" && value) return firstText(value.name, value.title, value.value);
  return cleanText(value);
}

function isAudioQualityTag(value) {
  const text = cleanText(value);
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/\s+/g, "");
  if (/^(?:lossless|hires|hireslossless|highres|highreslossless|master|mqa|atmos|dolbyatmos|sony360|aac|mp3|flac|alac|pcm|stereo|mono)$/.test(compact)) {
    return true;
  }
  if (/^\d+(?:\.\d+)?khz$/.test(compact) || /^\d+bit$/.test(compact)) {
    return true;
  }
  if (!/\b(?:lossless|hi\s*res|hires|high\s*res|mqa|dolby\s*atmos|flac|alac|pcm)\b/i.test(normalized)) {
    return false;
  }
  return !/\b(?:ambient|bass|breaks|chillout|disco|drum|dubstep|house|jungle|techno|trance)\b/i.test(normalized);
}

function cleanGenre(value) {
  const text = normalizeGenre(value);
  if (!text) return "";
  const parts = text.split(/\s*,\s*/).map(cleanText).filter(Boolean);
  const filtered = parts.filter((part) => !isAudioQualityTag(part));
  return filtered.join(", ");
}

function extractGenre(result = {}) {
  for (const candidate of [
    result.genre,
    result.genres,
    result.attributes?.genre,
    result.attributes?.genres,
    result.tags
  ]) {
    const genre = cleanGenre(candidate);
    if (genre) return genre;
  }
  return "";
}

function tidyUrl(value) {
  const text = cleanText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function isBridgeArtworkUrl(value = "") {
  return /\/art\/[a-f0-9]{40}\.jpg(?:$|[?#])/i.test(tidyUrl(value));
}

function providerResultToEntry(track, result, provider, confidenceInfo) {
  const releaseYear = firstYear(result.year, result.releaseYear, result.releaseDate, result.date);
  const durationMs = firstDurationMs(result.durationMs, result.length, result.duration);
  const sourceImageUrl = tidyUrl(result.imageUrl || result.albumArtUrl || result.coverImage);
  const beatportTags = Array.isArray(result.beatportTags)
    ? result.beatportTags.map(cleanGenre).filter(Boolean).slice(0, 8)
    : [];
  return {
    status: "found",
    key: metadataCacheKey(track),
    inputArtist: cleanText(track.artist),
    inputTitle: cleanText(track.title),
    title: cleanText(result.title) || cleanText(track.title),
    artist: cleanText(result.artist || resultArtistNames(result)) || cleanText(track.artist),
    album: firstText(result.album, result.releaseTitle),
    label: firstText(result.label),
    genre: extractGenre(result),
    musicBrainzTags: Array.isArray(result.musicBrainzTags)
      ? result.musicBrainzTags.map(cleanGenre).filter(Boolean).slice(0, 8)
      : [],
    beatportTags,
    bpm: Number(result.bpm || 0) > 0 ? Number(result.bpm) : null,
    keyName: firstText(result.keyName, result.key?.name),
    camelot: firstText(result.camelot, result.key?.camelot),
    id: cleanText(result.id || result.trackId),
    releaseYear,
    year: releaseYear,
    releaseDate: firstText(result.releaseDate, result.date),
    durationMs,
    sourceImageUrl,
    imageUrl: sourceImageUrl,
    tidalUrl: provider.startsWith("tidal") ? tidyUrl(result.tidalUrl || result.url) : "",
    beatportUrl: tidyUrl(result.beatportUrl),
    isrc: cleanIsrc(result.isrc),
    confidence: Number(confidenceInfo.confidence || 0),
    confidenceReason: confidenceInfo.reason || "",
    source: provider,
    updatedAt: new Date().toISOString()
  };
}

function sanitizeCachedEntry(entry = null) {
  if (!entry || typeof entry !== "object") return entry;
  return {
    ...entry,
    genre: cleanGenre(entry.genre)
  };
}

function entryHasBeatportGenre(entry = null) {
  if (!entry || typeof entry !== "object") return false;
  const beatport = entry.beatport || {};
  return Boolean(cleanGenre(beatport.genre) || cleanGenre(beatport.subGenre) || cleanGenre(entry.beatportTags));
}

function entryBeatportCanRetry(entry = null, clock = Date.now) {
  if (!entry || entry.status !== "found" || entryHasBeatportGenre(entry)) return false;
  const nextRetryMs = Date.parse(entry.beatportNextRetryAt || "");
  if (Number.isFinite(nextRetryMs) && nextRetryMs > 0) return nextRetryMs <= Number(clock());
  return !entry.beatportCheckedAt;
}

function markBeatportChecked(entry = null, clock = Date.now, retryDelayMs = DEFAULT_MISS_RETRY_MS) {
  if (!entry || typeof entry !== "object") return entry;
  const now = Number(clock());
  return {
    ...entry,
    beatportCheckedAt: new Date(now).toISOString(),
    beatportNextRetryAt: new Date(now + Math.max(30 * 1000, Number(retryDelayMs) || DEFAULT_MISS_RETRY_MS)).toISOString()
  };
}

function mergeBeatportEntry(primary = null, beatport = null) {
  if (!primary) return beatport;
  if (!beatport) return primary;
  const beatportGenre = cleanGenre(beatport.beatport?.genre || beatport.beatportTags?.[0]);
  const beatportSubGenre = cleanGenre(beatport.beatport?.subGenre || beatport.beatportTags?.[1]);
  return {
    ...primary,
    genre: [beatportGenre, beatportSubGenre].filter(Boolean).join(", ") || primary.genre,
    beatportTags: Array.isArray(beatport.beatportTags) && beatport.beatportTags.length ? beatport.beatportTags : primary.beatportTags,
    bpm: beatport.bpm || primary.bpm,
    keyName: beatport.keyName || primary.keyName,
    camelot: beatport.camelot || primary.camelot,
    beatportUrl: beatport.beatportUrl || primary.beatportUrl,
    beatport: beatport.beatport || primary.beatport,
    source: primary.source === "beatport" ? "beatport" : `${primary.source}+beatport`,
    confidence: Math.max(Number(primary.confidence || 0), Number(beatport.confidence || 0)),
    confidenceReason: [primary.confidenceReason, beatport.confidenceReason].filter(Boolean).join("; "),
    beatportCheckedAt: beatport.updatedAt || new Date().toISOString(),
    beatportNextRetryAt: ""
  };
}

function musicBrainzArtistText(recording = {}) {
  const credits = Array.isArray(recording["artist-credit"]) ? recording["artist-credit"] : [];
  return credits.map((credit) => credit?.artist?.name || credit?.name).filter(Boolean).join(", ");
}

function releaseDateFromMusicBrainz(release = {}) {
  return cleanText(release.date || release["first-release-date"]);
}

function musicBrainzGenreText(...sources) {
  return musicBrainzGenreList(...sources).join(", ");
}

function musicBrainzGenreList(...sources) {
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    for (const list of [source?.genres, source?.tags]) {
      for (const item of Array.isArray(list) ? list : []) {
        const name = cleanText(item?.name || item?.title || item?.value || item);
        const key = normalizeText(name);
        if (!key || seen.has(key) || isAudioQualityTag(name)) continue;
        seen.add(key);
        out.push(name);
      }
    }
  }
  return out.slice(0, 8);
}

class MetadataEnrichmentService {
  constructor({
    tidal,
    beatport,
    musicMemory,
    metadataResolver,
    cacheFile = path.join(__dirname, "..", "data", "metadata-enrichment-cache.json"),
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    missRetryMs = DEFAULT_MISS_RETRY_MS,
    maxMissRetryMs = DEFAULT_MAX_MISS_RETRY_MS,
    beatportMissingRetryMs = 7 * 24 * 60 * 60 * 1000,
    artBridge = {},
    fetchImpl = globalThis.fetch,
    clock = Date.now,
    logger = console
  } = {}) {
    this.tidal = tidal;
    this.beatport = beatport;
    this.musicMemory = musicMemory;
    this.metadataResolver = metadataResolver;
    this.cacheFile = cacheFile;
    this.minConfidence = Number(minConfidence) || DEFAULT_MIN_CONFIDENCE;
    this.timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.missRetryMs = Math.max(30 * 1000, Number(missRetryMs) || DEFAULT_MISS_RETRY_MS);
    this.maxMissRetryMs = Math.max(this.missRetryMs, Number(maxMissRetryMs) || DEFAULT_MAX_MISS_RETRY_MS);
    this.beatportMissingRetryMs = Math.max(60 * 1000, Number(beatportMissingRetryMs) || (7 * 24 * 60 * 60 * 1000));
    this.artBridge = {
      enabled: artBridge.enabled !== false,
      cacheUrl: tidyUrl(artBridge.cacheUrl),
      timeoutMs: Number(artBridge.timeoutMs) || 1200
    };
    this.fetchImpl = fetchImpl;
    this.clock = typeof clock === "function" ? clock : Date.now;
    this.logger = logger;
    this.cache = new Map();
    this.pending = new Map();
    this.artBridgePending = new Set();
    this.load();
  }

  load() {
    try {
      if (!this.cacheFile || !fs.existsSync(this.cacheFile)) return;
      const json = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
      const entries = Array.isArray(json?.entries) ? json.entries : [];
      this.cache = new Map(entries
        .filter((entry) => entry?.key)
        .map((entry) => [entry.key, entry]));
    } catch (error) {
      this.logger?.warn?.("Metadata enrichment cache could not be read", { error: error.message });
      this.cache = new Map();
    }
  }

  save() {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const payload = {
        version: CACHE_VERSION,
        updatedAt: new Date().toISOString(),
        entries: [...this.cache.values()]
      };
      const tmp = `${this.cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.cacheFile);
    } catch (error) {
      this.logger?.warn?.("Metadata enrichment cache could not be saved", { error: error.message });
    }
  }

  keyFor(track = {}) {
    return metadataCacheKey(track);
  }

  cachedEntry(track = {}) {
    const key = this.keyFor(track);
    return key ? sanitizeCachedEntry(this.cache.get(key) || null) : null;
  }

  displayableCachedEntry(track = {}) {
    const entry = this.cachedEntry(track);
    if (!entry || entry.status !== "found") return null;
    return Number(entry.confidence || 0) >= this.minConfidence ? entry : null;
  }

  shouldBridgeCachedArtwork(entry = null) {
    const imageUrl = tidyUrl(entry?.imageUrl);
    if (!imageUrl || !this.artBridge.enabled || !this.artBridge.cacheUrl) return false;
    return !isBridgeArtworkUrl(imageUrl);
  }

  async bridgeCachedArtwork(track = {}, entry = null) {
    const key = this.keyFor(track);
    if (!key || !this.shouldBridgeCachedArtwork(entry) || this.artBridgePending.has(key)) return null;
    this.artBridgePending.add(key);
    try {
      const bridgedUrl = await this.bridgeImageUrl(entry.imageUrl, track);
      if (!bridgedUrl || bridgedUrl === entry.imageUrl) return null;
      const nextEntry = {
        ...entry,
        sourceImageUrl: tidyUrl(entry.sourceImageUrl || entry.imageUrl),
        imageUrl: bridgedUrl,
        artworkCheckedAt: new Date(Number(this.clock())).toISOString(),
        updatedAt: new Date(Number(this.clock())).toISOString()
      };
      this.cache.set(key, nextEntry);
      this.save();
      return nextEntry;
    } finally {
      this.artBridgePending.delete(key);
    }
  }

  missingEntryCanRetry(entry = null) {
    if (!entry || entry.status !== "missing") return false;
    const now = Number(this.clock());
    const nextRetryMs = Date.parse(entry.nextRetryAt || "");
    if (Number.isFinite(nextRetryMs) && nextRetryMs > 0) return nextRetryMs <= now;
    const updatedMs = Date.parse(entry.updatedAt || "");
    return !Number.isFinite(updatedMs) || !updatedMs || now - updatedMs >= this.missRetryMs;
  }

  foundEntryCanRetry(entry = null) {
    if (!entry || entry.status !== "found") return false;
    if (this.beatport?.isConfigured?.() && entryBeatportCanRetry(entry, this.clock)) return true;
    if (isBridgeArtworkUrl(entry.imageUrl) && !tidyUrl(entry.sourceImageUrl)) {
      if (!entry.artworkCheckedAt) return true;
      const checkedMs = Date.parse(entry.artworkCheckedAt || "");
      return !Number.isFinite(checkedMs) || Number(this.clock()) - checkedMs >= this.maxMissRetryMs;
    }
    if (entry.imageUrl) return false;
    if (!entry.artworkCheckedAt) return true;
    const checkedMs = Date.parse(entry.artworkCheckedAt || "");
    return !Number.isFinite(checkedMs) || Number(this.clock()) - checkedMs >= this.maxMissRetryMs;
  }

  cachedEntryCanRetry(entry = null) {
    return this.missingEntryCanRetry(entry) || this.foundEntryCanRetry(entry);
  }

  shouldLookup(track = {}) {
    const key = this.keyFor(track);
    if (!key) return false;
    if (this.pending.has(key)) return false;
    const cached = sanitizeCachedEntry(this.cache.get(key));
    if (cached && !this.cachedEntryCanRetry(cached)) return false;
    return Boolean(cleanText(track.artist) && cleanText(track.title));
  }

  async bridgeImageUrl(imageUrl = "", track = {}) {
    const sourceUrl = tidyUrl(imageUrl);
    if (!sourceUrl || !this.artBridge.enabled || !this.artBridge.cacheUrl) return sourceUrl;

    const key = this.keyFor(track);
    try {
      const response = await fetchWithTimeout(this.artBridge.cacheUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          sourceUrl,
          imageKey: key ? `rabbit-hole:${key}` : "",
          artist: cleanText(track.artist),
          title: cleanText(track.title)
        })
      }, {
        timeoutMs: Math.max(300, Math.min(5000, this.artBridge.timeoutMs)),
        fetchImpl: this.fetchImpl,
        label: "artwork bridge cache"
      });
      if (!response.ok) return sourceUrl;
      const body = await response.json().catch(() => null);
      return tidyUrl(body?.url) || sourceUrl;
    } catch (error) {
      this.logger?.debug?.("Artwork bridge cache failed", { error: error.message });
      return sourceUrl;
    }
  }

  remember(track = {}, entry = null) {
    const key = this.keyFor(track);
    if (!key) return null;
    const previous = sanitizeCachedEntry(this.cache.get(key));
    const now = Number(this.clock());
    const nextEntry = entry || {
      status: "missing",
      key,
      inputArtist: cleanText(track.artist),
      inputTitle: cleanText(track.title),
      confidence: 0,
      attempts: Number(previous?.attempts || 0) + 1,
      updatedAt: new Date(now).toISOString()
    };
    if (nextEntry.status === "missing") {
      const retryDelayMs = Math.min(this.maxMissRetryMs, this.missRetryMs * Math.max(1, Number(nextEntry.attempts || 1)));
      nextEntry.nextRetryAt = new Date(now + retryDelayMs).toISOString();
    } else if (nextEntry.status === "found") {
      nextEntry.artworkCheckedAt = new Date(now).toISOString();
    }
    this.cache.set(key, nextEntry);
    this.save();
    return nextEntry;
  }

  async enrich(track = {}) {
    const key = this.keyFor(track);
    if (!key) return null;
    try {
      this.musicMemory?.rememberObservation?.(track, "metadata_enrichment");
    } catch (error) {
      this.logger?.debug?.("Rabbit Hole music memory observation failed", { error: error.message });
    }
    const cached = sanitizeCachedEntry(this.cache.get(key));
    if (cached && !this.cachedEntryCanRetry(cached)) {
      return cached.status === "found" && Number(cached.confidence || 0) >= this.minConfidence ? cached : null;
    }
    if (this.pending.has(key)) return this.pending.get(key);

    const promise = this.lookup(track)
      .then((entry) => {
        const remembered = this.remember(track, entry);
        return remembered?.status === "found" && Number(remembered.confidence || 0) >= this.minConfidence
          ? remembered
          : null;
      })
      .catch((error) => {
        this.logger?.debug?.("Metadata enrichment lookup failed", { error: error.message, key });
        this.remember(track, null);
        return null;
      })
      .finally(() => this.pending.delete(key));

    this.pending.set(key, promise);
    return promise;
  }

  async lookup(track = {}) {
    const tidal = await this.lookupTidal(track);
    if (tidal) {
      const beatport = await this.lookupBeatport(track);
      return beatport ? mergeBeatportEntry(tidal, beatport) : markBeatportChecked(tidal, this.clock, this.missRetryMs);
    }

    const beatport = await this.lookupBeatport(track);
    if (beatport) return beatport;

    const musicBrainz = await this.lookupMusicBrainz(track);
    if (musicBrainz) return musicBrainz;

    const discogs = await this.lookupDiscogs(track);
    if (discogs) return discogs;

    return null;
  }

  async lookupTidal(track = {}) {
    if (!this.tidal?.isConfigured?.()) return null;
    const candidates = [];
    const searches = [
      { track, provider: "tidal" }
    ];
    const normalizedTitle = stripSearchVersionTerms(track.title);
    if (normalizedTitle && normalizedTitle !== cleanText(track.title)) {
      searches.push({ track: { ...track, title: normalizedTitle }, provider: "tidal-normalized-title" });
    }

    for (const search of searches) {
      try {
        const result = await this.tidal.findExactTrack(search.track, {
          strict: false,
          limit: 8,
          includePageYear: false,
          maxQueries: 6
        });
        if (!result) continue;
        const confidence = confidenceForMatch(track, result);
        if (confidence.confidence >= this.minConfidence) {
          const entry = providerResultToEntry(track, result, search.provider, confidence);
          entry.imageUrl = await this.bridgeImageUrl(entry.sourceImageUrl || entry.imageUrl, track);
          candidates.push(entry);
        }
      } catch (error) {
        this.logger?.debug?.("TIDAL metadata enrichment failed", { error: error.message });
      }
    }

    return candidates.sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0))[0] || null;
  }

  async lookupBeatport(track = {}) {
    if (!this.beatport?.isConfigured?.()) return null;
    try {
      const cached = this.musicMemory?.findBeatportEnrichment?.(track);
      if (cached) return this.beatportResultToEntry(track, cached);
      if (this.musicMemory?.beatportLookupBlocked?.(track)) return null;
      const result = await this.beatport.findTrack(track);
      if (!result) {
        this.rememberBeatportAttempt(track, "missing");
        return null;
      }
      const title = result.mixName ? `${result.title} (${result.mixName})` : result.title;
      const confidence = confidenceForMatch(track, {
        ...result,
        title
      });
      if (confidence.confidence < this.minConfidence) {
        this.rememberBeatportAttempt(track, "missing", { confidence: confidence.confidence, reason: confidence.reason });
        return null;
      }
      try {
        this.musicMemory?.saveBeatportEnrichment?.(track, result, { confidence: confidence.confidence });
        this.musicMemory?.saveProviderEnrichment?.(track, "beatport", {
          ...result,
          providerTrackId: result.id,
          confidence: confidence.confidence,
          fetchedAt: new Date(Number(this.clock())).toISOString()
        });
        this.musicMemory?.saveEnrichmentAttempt?.(track, "beatport", {
          status: "found",
          confidence: confidence.confidence,
          fetchedAt: new Date(Number(this.clock())).toISOString()
        });
      } catch (error) {
        this.logger?.debug?.("Rabbit Hole music memory Beatport save failed", { error: error.message });
      }
      const entry = this.beatportResultToEntry(track, result, confidence);
      entry.imageUrl = await this.bridgeImageUrl(entry.sourceImageUrl || entry.imageUrl, track);
      return entry;
    } catch (error) {
      const status = Number(error.status || error.statusCode || 0) === 429 ? "rate_limited" : "failed";
      this.rememberBeatportAttempt(track, status, { error: error.message });
      this.logger?.debug?.("Beatport metadata enrichment failed", { error: error.message });
      return null;
    }
  }

  beatportResultToEntry(track = {}, result = {}, confidence = null) {
    const title = result.mixName ? `${result.title} (${result.mixName})` : result.title;
    const confidenceInfo = confidence || confidenceForMatch(track, {
      ...result,
      title
    });
    const entry = providerResultToEntry(track, {
        ...result,
        title,
        genre: [result.genre, result.subGenre].filter(Boolean).join(", "),
        beatportTags: result.beatportTags
      }, "beatport", confidenceInfo);
    entry.beatport = {
      id: entry.id,
      url: entry.beatportUrl,
      genre: result.genre || "",
      subGenre: result.subGenre || "",
      label: result.label || "",
      releaseDate: result.releaseDate || "",
      releaseId: result.releaseId || "",
      artistIds: Array.isArray(result.artistIds) ? result.artistIds : [],
      remixerIds: Array.isArray(result.remixerIds) ? result.remixerIds : [],
      durationMs: result.durationMs || null,
      bpm: entry.bpm,
      keyName: entry.keyName,
      camelot: entry.camelot,
      isrc: entry.isrc
    };
    return entry;
  }

  rememberBeatportAttempt(track = {}, status = "missing", extra = {}) {
    try {
      this.musicMemory?.saveEnrichmentAttempt?.(track, "beatport", {
        status,
        confidence: extra.confidence || 0,
        error: extra.error || extra.reason || "",
        fetchedAt: new Date(Number(this.clock())).toISOString(),
        nextRetryAt: new Date(Number(this.clock()) + this.beatportMissingRetryMs).toISOString()
      });
    } catch (error) {
      this.logger?.debug?.("Rabbit Hole music memory Beatport attempt save failed", { error: error.message });
    }
  }

  async lookupMusicBrainz(track = {}) {
    if (!this.metadataResolver?.searchRecordings) return null;
    let recordings = [];
    try {
      recordings = await this.metadataResolver.searchRecordings(track);
    } catch (error) {
      this.logger?.debug?.("MusicBrainz metadata enrichment failed", { error: error.message });
      return null;
    }

    for (const recording of recordings || []) {
      const candidate = {
        title: cleanText(recording.title),
        artist: musicBrainzArtistText(recording)
      };
      const confidence = confidenceForMatch(track, candidate);
      if (confidence.confidence < this.minConfidence) continue;
      const release = chooseRelease(recording) || {};
      const releaseDate = releaseDateFromMusicBrainz(release);
      const entry = providerResultToEntry(track, {
        ...candidate,
        album: cleanText(release.title || recording.title),
        genre: musicBrainzGenreText(recording, release, release["release-group"]),
        musicBrainzTags: musicBrainzGenreList(recording, release, release["release-group"]),
        releaseDate,
        year: firstYear(releaseDate),
        durationMs: firstDurationMs(recording.length)
      }, "musicbrainz", confidence);
      entry.sourceImageUrl = await this.lookupMusicBrainzCover(release).catch(() => "");
      entry.imageUrl = await this.bridgeImageUrl(entry.sourceImageUrl, track);
      return entry;
    }

    return null;
  }

  async lookupMusicBrainzCover(release = {}) {
    const releaseId = cleanText(release.id);
    const groupId = cleanText(release["release-group"]?.id);
    if (!releaseId && !groupId) return "";
    const coverUrl = groupId
      ? `https://coverartarchive.org/release-group/${groupId}`
      : `https://coverartarchive.org/release/${releaseId}`;
    const response = await fetchWithTimeout(coverUrl, {
      headers: {
        accept: "application/json",
        "user-agent": "RoonLocalAI/0.1.0"
      }
    }, {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      label: "MusicBrainz cover art lookup"
    });
    if (!response.ok) return "";
    const json = await response.json();
    return tidyUrl(chooseCoverImage(json));
  }

  async lookupDiscogs(track = {}) {
    if (!this.metadataResolver?.lookupDiscogs) return null;
    try {
      const result = await this.metadataResolver.lookupDiscogs(track, this.keyFor(track));
      if (!result) return null;
      const confidence = confidenceForMatch(track, {
        title: result.title || track.title,
        artist: result.artist || track.artist
      });
      if (confidence.confidence < this.minConfidence) return null;
      const entry = providerResultToEntry(track, {
        ...result,
        imageUrl: result.albumArtUrl
      }, "discogs", confidence);
      entry.imageUrl = await this.bridgeImageUrl(entry.sourceImageUrl || entry.imageUrl, track);
      return entry;
    } catch (error) {
      this.logger?.debug?.("Discogs metadata enrichment failed", { error: error.message });
      return null;
    }
  }

  status() {
    return {
      enabled: true,
      cacheSize: this.cache.size,
      pending: this.pending.size,
      minConfidence: this.minConfidence,
      missRetryMs: this.missRetryMs,
      musicMemory: this.musicMemory?.status?.() || null,
      beatport: this.beatport?.status?.() || null
    };
  }
}

module.exports = {
  MetadataEnrichmentService,
  cleanText,
  normalizeText,
  stripSearchVersionTerms,
  metadataCacheKey,
  confidenceForMatch,
  providerResultToEntry
};
