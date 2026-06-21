"use strict";

const {
  CircuitBreaker,
  DEFAULT_TIDAL_CIRCUIT_COOLDOWN_MS,
  DEFAULT_TIDAL_CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_TIDAL_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  httpStatusError,
  positiveNumber
} = require("./tidalRequestGuard");
const { TidalProfileAuth } = require("./tidalProfileAuth");

const USER_AGENT = "RoonLocalAI/0.1.0";
const TIDAL_OPENAPI_ROOT = "https://openapi.tidal.com/v2";
const DEFAULT_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_ARTIST_RADIO_LIMIT = 12;
const FULL_MIXES_SCOPE = "r_usr";
const DEFAULT_ENDPOINTS = [
  "https://api.tidal.com/v1/pages/home",
  "https://api.tidal.com/v1/pages/mixes"
];
const MIX_CATEGORY_ORDER = ["Daily Discovery", "My Mix", "New Arrivals", "Track Radio", "Artist Radio", "Radio", "Mix"];
const RECOMMENDATION_RELATIONSHIPS = [
  { key: "discoveryMixes", category: "Daily Discovery" },
  { key: "newArrivalMixes", category: "New Arrivals" },
  { key: "myMixes", category: "My Mix" },
  { key: "offlineMixes", category: "Offline Mix" }
];

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scopeTokens(value = "") {
  return cleanText(value).split(/\s+/).filter(Boolean);
}

function hasScope(value = "", scope = "") {
  return scopeTokens(value).includes(scope);
}

function imageUrlFromTidalId(value, size = 640) {
  const id = cleanText(value);
  if (/^https?:\/\//i.test(id)) return id;
  if (!/^[a-f0-9-]{32,36}$/i.test(id)) return "";
  const path = id.replace(/-/g, "/");
  return `https://resources.tidal.com/images/${path}/${size}x${size}.jpg`;
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function firstUrl(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (/^https?:\/\//i.test(text)) return text;
    const tidalImage = imageUrlFromTidalId(text);
    if (tidalImage) return tidalImage;
  }
  return "";
}

function imageFromLinks(value) {
  if (!value) return "";
  if (typeof value === "string") return firstUrl(value);
  const links = Array.isArray(value) ? value : Object.values(value).flat();
  return firstUrl(...links.map((link) => {
    if (typeof link === "string") return link;
    return link?.href || link?.url || link?.imageUrl || link?.src;
  }));
}

function imageFromObject(item = {}) {
  const attributes = item.attributes || {};
  const images = item.images || item.image || item.picture || item.pictures || {};
  return firstUrl(
    item.imageUrl,
    item.imageURL,
    item.cover,
    item.coverArt,
    item.imageId,
    item.squareImage,
    item.thumbnail,
    attributes.imageUrl,
    attributes.imageURL,
    attributes.cover,
    attributes.coverArt,
    attributes.imageId,
    attributes.squareImage,
    attributes.thumbnail,
    imageFromLinks(item.imageLinks || attributes.imageLinks),
    imageFromLinks(images)
  );
}

function imageFromArtworkObject(item = {}) {
  const attributes = item.attributes || {};
  const files = Array.isArray(attributes.files) ? attributes.files : [];
  const candidates = files
    .map((file) => ({
      href: cleanText(file?.href),
      width: Number(file?.meta?.width || 0),
      height: Number(file?.meta?.height || 0)
    }))
    .filter((file) => /^https?:\/\//i.test(file.href))
    .sort((left, right) => Math.max(right.width, right.height) - Math.max(left.width, left.height));
  return candidates[0]?.href || "";
}

function externalUrlFromObject(item = {}) {
  const attributes = item.attributes || {};
  const links = item.links || attributes.links || {};
  return firstUrl(
    item.url,
    item.shareUrl,
    item.webUrl,
    item.externalUrl,
    attributes.url,
    attributes.shareUrl,
    attributes.webUrl,
    attributes.externalUrl,
    links.self,
    links.web,
    links.share
  );
}

function titleFromObject(item = {}) {
  const attributes = item.attributes || {};
  return firstText(
    item.title,
    item.name,
    item.header,
    item.heading,
    item.shortHeader,
    item.mixTitle,
    attributes.title,
    attributes.name,
    attributes.header,
    attributes.heading
  );
}

function subtitleFromObject(item = {}) {
  const attributes = item.attributes || {};
  const artists = Array.isArray(item.artists) ? item.artists.map((artist) => artist?.name || artist).filter(Boolean).join(", ") : "";
  return firstText(
    item.subtitle,
    item.subTitle,
    item.description,
    item.text,
    item.shortDescription,
    item.artist?.name,
    artists,
    attributes.subtitle,
    attributes.subTitle,
    attributes.description,
    attributes.shortDescription
  );
}

function idFromObject(item = {}) {
  const attributes = item.attributes || {};
  return firstText(
    item.id,
    item.uuid,
    item.mixId,
    item.trn,
    item.apiPath,
    item.path,
    attributes.id,
    attributes.uuid,
    attributes.mixId,
    attributes.trn
  );
}

function rawTypeFromObject(item = {}, path = "") {
  const attributes = item.attributes || {};
  return firstText(
    item.type,
    item.contentType,
    item.itemType,
    item.moduleType,
    item.kind,
    item.apiPath,
    attributes.type,
    attributes.contentType,
    attributes.itemType,
    path
  );
}

function mixCategory(title = "", rawType = "", subtitle = "") {
  const text = normalizeText(`${title} ${rawType} ${subtitle}`);
  if (/\bdaily discovery\b/.test(text)) return "Daily Discovery";
  if (/\bnew arrivals\b/.test(text)) return "New Arrivals";
  if (/\bmy mix\b/.test(text)) return "My Mix";
  if (/\btrack radio\b/.test(text)) return "Track Radio";
  if (/\bartist radio\b/.test(text)) return "Artist Radio";
  if (/\bradio\b/.test(text)) return "Radio";
  return "Mix";
}

function looksLikeTidalMix(item = {}, path = "") {
  const title = titleFromObject(item);
  if (!title) return false;
  const rawType = rawTypeFromObject(item, path);
  const subtitle = subtitleFromObject(item);
  const id = idFromObject(item);
  const text = normalizeText(`${title} ${subtitle} ${rawType} ${id} ${path}`);
  if (/\bvideo\b/.test(text)) return false;
  if (/\bmy\s+mix\s*\d+\b|\bdaily discovery\b|\bnew arrivals\b|\btrack radio\b|\bartist radio\b/.test(text)) return true;
  return /\b(?:personal|for you|curated)\b/.test(text) && /\b(?:mix|radio)\b/.test(text);
}

function walkObjects(value, visit, path = "$", depth = 0, seen = new Set()) {
  if (!value || depth > 9) return;
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (!Array.isArray(value)) visit(value, path);

  if (Array.isArray(value)) {
    value.forEach((item, index) => walkObjects(item, visit, `${path}[${index}]`, depth + 1, seen));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    walkObjects(child, visit, `${path}.${key}`, depth + 1, seen);
  }
}

function normalizeTidalMixesPayload(payload = {}) {
  const mixes = [];
  const seen = new Set();

  walkObjects(payload, (item, path) => {
    if (!looksLikeTidalMix(item, path)) return;
    const title = titleFromObject(item);
    const rawType = rawTypeFromObject(item, path);
    const subtitle = subtitleFromObject(item);
    const id = idFromObject(item);
    const key = normalizeText([id, title, subtitle, rawType].filter(Boolean).join("|"));
    if (!key || seen.has(key)) return;
    seen.add(key);

    mixes.push({
      id,
      title,
      subtitle,
      category: mixCategory(title, rawType, subtitle),
      rawType,
      imageUrl: imageFromObject(item),
      url: externalUrlFromObject(item),
      sourcePath: path
    });
  });

  return sortMixes(mixes);
}

function mixSortIndex(category = "") {
  const index = MIX_CATEGORY_ORDER.indexOf(category);
  return index === -1 ? 99 : index;
}

function sortMixes(mixes = []) {
  return mixes.sort((left, right) => (
    mixSortIndex(left.category) - mixSortIndex(right.category) ||
    cleanText(left.title).localeCompare(cleanText(right.title))
  ));
}

function mixIdentity(mix = {}) {
  const id = cleanText(mix.id);
  if (id) return `id:${id}`;
  return `title:${normalizeText([mix.category, mix.title, mix.subtitle].filter(Boolean).join("|"))}`;
}

function mergeMixLists(...lists) {
  const map = new Map();
  for (const mix of lists.flat().filter(Boolean)) {
    const key = mixIdentity(mix);
    if (!key || key === "title:") continue;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...mix });
      continue;
    }
    const sourcePaths = Array.from(new Set([existing.sourcePath, mix.sourcePath].filter(Boolean)));
    map.set(key, {
      ...existing,
      id: existing.id || mix.id || "",
      title: existing.title || mix.title || "",
      subtitle: existing.subtitle || mix.subtitle || "",
      category: existing.category || mix.category || "Mix",
      rawType: existing.rawType || mix.rawType || "",
      imageUrl: existing.imageUrl || mix.imageUrl || "",
      url: existing.url || mix.url || "",
      itemCount: existing.itemCount || mix.itemCount || 0,
      sourcePath: sourcePaths.join(", ")
    });
  }
  return sortMixes([...map.values()]);
}

function configuredEndpoints(endpointConfig = "") {
  return cleanText(endpointConfig)
    .split(/\s*[\n,]\s*/)
    .map(cleanText)
    .filter(Boolean);
}

function withCommonParams(endpoint, config = {}) {
  const url = new URL(endpoint.replace(/\{userId\}/g, encodeURIComponent(config.userId || "")));
  if (!url.searchParams.has("countryCode")) url.searchParams.set("countryCode", config.countryCode || "US");
  if (!url.searchParams.has("locale")) url.searchParams.set("locale", config.locale || "en_US");
  if (!url.searchParams.has("deviceType")) url.searchParams.set("deviceType", config.deviceType || "BROWSER");
  return url.toString();
}

function bcp47Locale(value = "") {
  return cleanText(value || "en-US").replace("_", "-") || "en-US";
}

function openApiUrl(pathname, params = {}) {
  const url = new URL(`${TIDAL_OPENAPI_ROOT}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    const text = cleanText(value);
    if (text) url.searchParams.set(key, text);
  }
  return url.toString();
}

function relationshipRefs(payload = {}, relationshipKey = "") {
  const refs = payload?.data?.relationships?.[relationshipKey]?.data;
  return Array.isArray(refs) ? refs.filter((ref) => ref?.id) : [];
}

function firstExternalLink(attributes = {}) {
  const links = Array.isArray(attributes.externalLinks) ? attributes.externalLinks : [];
  return firstUrl(...links.map((link) => link?.href));
}

function playlistUrlFromId(id = "") {
  const safeId = cleanText(id);
  return safeId ? `https://listen.tidal.com/playlist/${encodeURIComponent(safeId)}` : "";
}

function durationMsFromIsoDuration(value = "") {
  const text = cleanText(value);
  const match = text.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
}

function stripTrackVersion(value = "") {
  return cleanText(value)
    .replace(/\s*[\[(][^)\]]*\b(?:remix|mix|rework|rerub|dub|edit|version)\b[^)\]]*[\])]/gi, "")
    .trim();
}

function titleMatchKeys(value = "") {
  return Array.from(new Set([
    normalizeText(value),
    normalizeText(stripTrackVersion(value))
  ].filter(Boolean)));
}

function artistMatchKeys(value = "") {
  return cleanText(value)
    .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
    .map(normalizeText)
    .filter((part) => part && part.length > 1);
}

function trackTidalId(track = {}) {
  const direct = cleanText(track.tidal?.id || track.tidalId || track.id);
  if (direct && !/^https?:\/\//i.test(direct)) return direct;
  const url = trackTidalUrl(track);
  const match = url.match(/\/track\/([^/?#]+)/i);
  return cleanText(match?.[1]);
}

function trackTidalUrl(track = {}) {
  return cleanText(track.tidal?.tidalUrl || track.tidalUrl || track.url);
}

function uniqueTidalTrackRefs(tracks = []) {
  const refs = [];
  const skipped = [];
  const seen = new Set();
  for (const track of tracks || []) {
    const id = trackTidalId(track);
    if (!id) {
      skipped.push({
        title: cleanText(track?.title || track?.tidal?.title),
        artist: cleanText(track?.artist || track?.tidal?.artist),
        reason: "missing TIDAL track id"
      });
      continue;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      id,
      type: "tracks",
      title: cleanText(track?.title || track?.tidal?.title),
      artist: cleanText(track?.artist || track?.tidal?.artist)
    });
  }
  return { refs, skipped };
}

function queuePlaylistTitle(now = Date.now()) {
  const date = new Date(now);
  const stamp = Number.isFinite(date.getTime())
    ? date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-")
    : "now";
  return `Rabbit Hole Queue - ${stamp}`;
}

function normalizeCreatedPlaylist(payload = {}, fallbackTitle = "") {
  const data = payload?.data || payload || {};
  const attributes = data.attributes || {};
  const id = cleanText(data.id);
  const title = firstText(attributes.name, data.name, data.title, fallbackTitle);
  return {
    id,
    title,
    description: cleanText(attributes.description),
    url: firstExternalLink(attributes) || playlistUrlFromId(id),
    rawType: firstText(attributes.playlistType, data.type, "playlist")
  };
}

function normalizeUserPlaylist(payload = {}, fallbackTitle = "") {
  const data = payload?.data || payload || {};
  const attributes = data.attributes || {};
  const id = cleanText(data.id);
  const title = firstText(attributes.name, data.name, data.title, fallbackTitle || id);
  if (!id || !title) return null;
  return {
    id,
    title,
    description: cleanText(attributes.description),
    url: firstExternalLink(attributes) || playlistUrlFromId(id),
    rawType: firstText(attributes.playlistType, data.type, "playlist"),
    itemCount: itemCountFromPlaylist({ data })
  };
}

function playlistSummariesFromPayload(payload = {}) {
  const included = new Map();
  for (const item of Array.isArray(payload.included) ? payload.included : []) {
    if (item?.type === "playlists" && item.id) included.set(cleanText(item.id), item);
  }

  const refs = [];
  if (Array.isArray(payload.data)) refs.push(...payload.data);
  const relationshipRefs = payload.data?.relationships?.playlists?.data;
  if (Array.isArray(relationshipRefs)) refs.push(...relationshipRefs);

  const summaries = [];
  for (const ref of refs) {
    if (ref?.type !== "playlists" || !ref.id) continue;
    const full = ref.attributes ? ref : (included.get(cleanText(ref.id)) || ref);
    const summary = normalizeUserPlaylist(full);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

function trackMatches(left = {}, right = {}) {
  const leftTidalId = trackTidalId(left);
  const rightTidalId = trackTidalId(right);
  if (leftTidalId && rightTidalId && leftTidalId === rightTidalId) return true;

  const leftTidalUrl = trackTidalUrl(left).toLowerCase();
  const rightTidalUrl = trackTidalUrl(right).toLowerCase();
  if (leftTidalUrl && rightTidalUrl && leftTidalUrl === rightTidalUrl) return true;

  const leftTitles = titleMatchKeys(left.title || left.tidal?.title);
  const rightTitles = titleMatchKeys(right.title || right.tidal?.title);
  const titleMatched = leftTitles.some((leftTitle) => rightTitles.some((rightTitle) => leftTitle === rightTitle));
  if (!titleMatched) return false;

  const leftArtists = artistMatchKeys(left.artist || left.tidal?.artist);
  const rightArtists = artistMatchKeys(right.artist || right.tidal?.artist);
  if (!leftArtists.length || !rightArtists.length) return false;
  return leftArtists.some((leftArtist) => rightArtists.some((rightArtist) => (
    leftArtist === rightArtist || leftArtist.includes(rightArtist) || rightArtist.includes(leftArtist)
  )));
}

function filterExcludedTracks(tracks = [], excludeTracks = []) {
  const excluded = Array.isArray(excludeTracks) ? excludeTracks : [];
  if (!excluded.length) return { tracks, excludedCount: 0 };
  const kept = [];
  let excludedCount = 0;
  for (const track of tracks || []) {
    if (excluded.some((existing) => trackMatches(track, existing))) {
      excludedCount += 1;
      continue;
    }
    kept.push(track);
  }
  return { tracks: kept, excludedCount };
}

function itemCountFromPlaylist(payload = {}) {
  const items = payload?.data?.relationships?.items?.data;
  return Array.isArray(items) ? items.length : 0;
}

function coverArtIdFromPlaylist(payload = {}) {
  const coverArt = payload?.data?.relationships?.coverArt?.data;
  if (Array.isArray(coverArt)) return cleanText(coverArt[0]?.id);
  return cleanText(coverArt?.id);
}

function normalizeOfficialPlaylistMix({ playlist = {}, imageUrl = "", category = "Mix", relationship = "" } = {}) {
  const data = playlist.data || playlist;
  const attributes = data.attributes || {};
  const title = firstText(attributes.name, data.name, data.title);
  if (!title) return null;
  const itemCount = itemCountFromPlaylist(playlist);
  return {
    id: cleanText(data.id),
    title,
    subtitle: cleanText(attributes.description),
    category,
    rawType: firstText(attributes.playlistType, data.type, relationship),
    imageUrl,
    url: firstExternalLink(attributes),
    itemCount,
    sourcePath: `/userRecommendations/me/relationships/${relationship}`
  };
}

function artistNamesFromMixSubtitle(value = "") {
  return cleanText(value)
    .replace(/\band\s+more\b/gi, "")
    .split(/\s*,\s*|\s+\&\s+|\s+\+\s+/)
    .map((name) => cleanText(name.replace(/\s+and\s*$/i, "")))
    .filter((name) => name.length >= 2 && !/\bmore\b/i.test(name));
}

function includedByTypeAndId(payload = {}) {
  const map = new Map();
  for (const item of payload.included || []) {
    if (!item?.type || !item?.id) continue;
    map.set(`${item.type}:${item.id}`, item);
  }
  return map;
}

function relationshipItems(resource = {}, relationship = "") {
  const data = resource?.relationships?.[relationship]?.data;
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

function normalizeOfficialPlaylistTracks(payload = {}, { mix = null } = {}) {
  const included = includedByTypeAndId(payload);
  const orderedRefs = Array.isArray(payload.data) ? payload.data : [];
  return orderedRefs
    .map((ref) => included.get(`${ref.type}:${ref.id}`) || ref)
    .filter((track) => track?.type === "tracks")
    .map((track) => {
      const attributes = track.attributes || {};
      const artists = relationshipItems(track, "artists")
        .map((artistRef) => included.get(`${artistRef.type}:${artistRef.id}`)?.attributes?.name)
        .map(cleanText)
        .filter(Boolean);
      const albumRef = relationshipItems(track, "albums")[0];
      const album = albumRef ? included.get(`${albumRef.type}:${albumRef.id}`) : null;
      const title = firstText(
        attributes.version ? `${attributes.title || ""} (${attributes.version})` : "",
        attributes.title,
        track.title
      );
      const artist = artists.join(", ");
      if (!title || !artist) return null;
      return {
        title,
        artist,
        album: firstText(album?.attributes?.title),
        year: cleanText(album?.attributes?.releaseDate || "").slice(0, 4),
        releaseDate: cleanText(album?.attributes?.releaseDate),
        durationMs: durationMsFromIsoDuration(attributes.duration),
        label: cleanText(attributes.copyright?.text || album?.attributes?.copyright?.text),
        source: "TIDAL profile mix",
        discoverySource: mix?.title ? `TIDAL mix: ${mix.title}` : "TIDAL profile mix",
        tidal: {
          id: cleanText(track.id),
          title,
          artist,
          album: firstText(album?.attributes?.title),
          durationMs: durationMsFromIsoDuration(attributes.duration),
          tidalUrl: firstExternalLink(attributes),
          verified: true
        },
        tidalUrl: firstExternalLink(attributes)
      };
    })
    .filter(Boolean);
}

class TidalProfileMixes {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.countryCode = config.countryCode || "US";
    this.locale = config.locale || "en_US";
    this.deviceType = config.deviceType || "BROWSER";
    this.userId = config.userId || "";
    this.clientId = config.clientId || config.profileClientId || "";
    this.accessToken = config.accessToken || "";
    this.artistRadioFallback = config.artistRadioFallback === true;
    this.auth = config.auth || new TidalProfileAuth(config);
    this.endpoint = config.endpoint || "";
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.clock = config.clock || (() => Date.now());
    this.timeoutMs = positiveNumber(config.timeoutMs, DEFAULT_TIDAL_FETCH_TIMEOUT_MS, { min: 500, max: 120_000 });
    this.cacheMs = positiveNumber(config.cacheMs, DEFAULT_CACHE_MS, { min: 0, max: 60 * 60_000 });
    this.circuitBreaker = config.circuitBreaker || new CircuitBreaker({
      label: "TIDAL profile mixes",
      failureThreshold: config.failureThreshold || DEFAULT_TIDAL_CIRCUIT_FAILURE_THRESHOLD,
      cooldownMs: config.circuitCooldownMs || DEFAULT_TIDAL_CIRCUIT_COOLDOWN_MS,
      clock: this.clock
    });
    this.cache = null;
    this.playlistCache = null;
    this.userIdCache = "";
  }

  isConfigured() {
    return Boolean(this.enabled && (this.accessToken || this.auth?.status?.().configured));
  }

  status() {
    const authStatus = this.auth?.status?.() || {};
    return {
      enabled: this.enabled,
      configured: this.isConfigured(),
      oauth: authStatus,
      userIdConfigured: Boolean(this.userId),
      endpointConfigured: Boolean(configuredEndpoints(this.endpoint).length),
      artistRadioFallback: this.artistRadioFallback,
      timeoutMs: this.timeoutMs,
      cacheMs: this.cacheMs,
      circuit: this.circuitBreaker.status(),
      lastFetchedAt: this.cache?.fetchedAt || "",
      lastError: this.cache?.error || ""
    };
  }

  endpoints() {
    const endpoints = configuredEndpoints(this.endpoint);
    const base = endpoints.length ? endpoints : DEFAULT_ENDPOINTS;
    return Array.from(new Set(base.map((endpoint) => withCommonParams(endpoint, this))));
  }

  hasFullMixesScope() {
    return hasScope(this.auth?.status?.().scope || "", FULL_MIXES_SCOPE);
  }

  async fetchJson(url, {
    accept = "application/json",
    method = "GET",
    body = null,
    contentType = ""
  } = {}) {
    this.circuitBreaker.assertCanRequest();
    const token = this.auth ? await this.auth.getAccessToken() : this.accessToken;
    if (!token) throw new Error("TIDAL profile access token is missing.");
    let response;
    const headers = {
      accept,
      authorization: `Bearer ${token}`,
      "user-agent": USER_AGENT
    };
    if (this.clientId) headers["x-tidal-token"] = this.clientId;
    if (contentType) headers["content-type"] = contentType;

    const request = {
      method,
      headers
    };
    if (body !== null && body !== undefined) {
      request.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    try {
      response = await fetchWithTimeout(url, request, {
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        label: "TIDAL profile mixes"
      });
    } catch (error) {
      this.circuitBreaker.recordFailure(error);
      throw error;
    }

    const text = await response.text().catch(() => "");
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!response.ok) {
      const detail = cleanText(
        json?.errors?.[0]?.detail ||
        json?.errors?.[0]?.title ||
        json?.error_description ||
        json?.error ||
        text
      );
      const error = httpStatusError("TIDAL profile mixes", response.status);
      if (detail) error.message = `${error.message}: ${detail}`;
      this.circuitBreaker.recordFailure(error);
      throw error;
    }

    this.circuitBreaker.recordSuccess();
    return json || { ok: true, status: response.status };
  }

  async fetchOpenApiJson(pathname, params = {}, options = {}) {
    return this.fetchJson(openApiUrl(pathname, params), {
      accept: "application/vnd.api+json",
      ...options
    });
  }

  hasPlaylistWriteScope() {
    const scope = this.auth?.status?.().scope || "";
    return !scope || hasScope(scope, "playlists.write");
  }

  assertPlaylistWriteReady() {
    if (!this.isConfigured()) throw inputError("TIDAL profile token missing. Connect TIDAL profile access first.");
    if (!this.hasPlaylistWriteScope()) {
      throw inputError("TIDAL profile token does not include playlists.write. Reconnect TIDAL from Rabbit Hole after adding that scope.");
    }
  }

  async currentUserId() {
    if (this.userId) return this.userId;
    if (this.userIdCache) return this.userIdCache;
    const payload = await this.fetchOpenApiJson("/users/me", {
      countryCode: this.countryCode
    });
    const id = cleanText(payload?.data?.id || payload?.id);
    if (!id) throw new Error("TIDAL did not return the current user id.");
    this.userIdCache = id;
    return id;
  }

  async userPlaylistRelationshipPaths() {
    let currentUserId = "";
    try {
      currentUserId = await this.currentUserId();
    } catch {
      currentUserId = "";
    }

    return Array.from(new Set([
      currentUserId ? `/userCollections/${encodeURIComponent(currentUserId)}/relationships/playlists` : "",
      this.userId ? `/userCollections/${encodeURIComponent(this.userId)}/relationships/playlists` : "",
      currentUserId ? `/users/${encodeURIComponent(currentUserId)}/relationships/playlists` : "",
      "/users/me/relationships/playlists",
      currentUserId ? `/userProfiles/${encodeURIComponent(currentUserId)}/relationships/playlists` : "",
      "/userProfiles/me/relationships/playlists",
      "/userCollections/me/relationships/playlists"
    ].filter(Boolean)));
  }

  async fetchUserPlaylistPage(pathname = "", cursor = "") {
    const params = {
      countryCode: this.countryCode,
      include: "playlists",
      "page[limit]": "50"
    };
    if (cursor) params["page[cursor]"] = cursor;
    const payload = await this.fetchOpenApiJson(pathname, params);
    const next = cleanText(payload?.links?.next);
    let nextCursor = "";
    if (next) {
      try {
        const nextUrl = new URL(next, TIDAL_OPENAPI_ROOT);
        nextCursor = cleanText(nextUrl.searchParams.get("page[cursor]"));
      } catch {
        nextCursor = "";
      }
    }
    return {
      payload,
      nextCursor,
      endpoint: openApiUrl(pathname, params)
    };
  }

  async fetchPlaylistSummary(playlistId = "") {
    const id = cleanText(playlistId);
    if (!id) return null;
    const params = {
      countryCode: this.countryCode,
      include: "items"
    };
    const payload = await this.fetchOpenApiJson(`/playlists/${encodeURIComponent(id)}`, params);
    return {
      playlist: normalizeUserPlaylist(payload),
      endpoint: openApiUrl(`/playlists/${encodeURIComponent(id)}`, params)
    };
  }

  async getUserPlaylists({ force = false } = {}) {
    const status = this.status();
    if (!this.enabled) return { ...status, connected: false, playlists: [], error: "TIDAL profile mixes are disabled." };
    if (!this.isConfigured()) {
      return {
        ...status,
        connected: false,
        playlists: [],
        error: "TIDAL profile token missing. Connect TIDAL profile access first."
      };
    }

    const now = this.clock();
    if (!force && this.playlistCache?.result && this.cacheMs && now - this.playlistCache.fetchedAtMs < this.cacheMs) {
      return this.playlistCache.result;
    }

    const attemptedEndpoints = [];
    let lastError = "";
    for (const pathname of await this.userPlaylistRelationshipPaths()) {
      const playlists = [];
      let cursor = "";
      let page = 0;
      try {
        do {
          const pageResult = await this.fetchUserPlaylistPage(pathname, cursor);
          attemptedEndpoints.push(pageResult.endpoint);
          playlists.push(...playlistSummariesFromPayload(pageResult.payload));
          cursor = pageResult.nextCursor;
          page += 1;
        } while (cursor && page < 5);

        const seen = new Set();
        const unique = playlists
          .filter((playlist) => {
            const key = playlist.id.toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort((left, right) => left.title.localeCompare(right.title));
        const detailed = [];
        for (const playlist of unique) {
          if (playlist.title !== playlist.id) {
            detailed.push(playlist);
            continue;
          }
          try {
            const detail = await this.fetchPlaylistSummary(playlist.id);
            if (detail?.endpoint) attemptedEndpoints.push(detail.endpoint);
            detailed.push(detail?.playlist || playlist);
          } catch {
            detailed.push(playlist);
          }
        }

        const result = {
          ...this.status(),
          connected: true,
          playlists: detailed.sort((left, right) => left.title.localeCompare(right.title)),
          count: detailed.length,
          attemptedEndpoints,
          sourceEndpoint: attemptedEndpoints.at(-1) || "",
          fetchedAt: new Date(now).toISOString(),
          warning: detailed.length ? "" : "TIDAL responded, but no user playlists were found."
        };
        this.playlistCache = { result, fetchedAtMs: now, fetchedAt: result.fetchedAt, error: result.warning || "" };
        return result;
      } catch (error) {
        lastError = error.message;
        attemptedEndpoints.push(`${openApiUrl(pathname)} -> ${error.message}`);
      }
    }

    const result = {
      ...this.status(),
      connected: false,
      playlists: [],
      count: 0,
      attemptedEndpoints,
      error: lastError || "No TIDAL user playlist endpoint returned data."
    };
    this.playlistCache = { result, fetchedAtMs: now, fetchedAt: "", error: result.error };
    return result;
  }

  async createPlaylist({ title = "", description = "" } = {}) {
    this.assertPlaylistWriteReady();
    const safeTitle = cleanText(title) || queuePlaylistTitle(this.clock());
    const payload = await this.fetchOpenApiJson("/playlists", {
      countryCode: this.countryCode
    }, {
      method: "POST",
      contentType: "application/vnd.api+json",
      body: {
        data: {
          type: "playlists",
          attributes: {
            name: safeTitle,
            description: cleanText(description)
          }
        }
      }
    });
    return normalizeCreatedPlaylist(payload, safeTitle);
  }

  async addTracksToPlaylist(playlistId = "", refs = []) {
    this.assertPlaylistWriteReady();
    const id = cleanText(playlistId);
    if (!id) throw inputError("Missing TIDAL playlist id.");
    const trackRefs = (refs || []).filter((ref) => ref?.id).map((ref) => ({
      id: cleanText(ref.id),
      type: "tracks"
    }));
    if (!trackRefs.length) return { addedCount: 0, chunks: 0 };

    let addedCount = 0;
    let chunks = 0;
    for (let index = 0; index < trackRefs.length; index += 50) {
      const data = trackRefs.slice(index, index + 50);
      await this.fetchOpenApiJson(`/playlists/${encodeURIComponent(id)}/relationships/items`, {
        countryCode: this.countryCode
      }, {
        method: "POST",
        contentType: "application/vnd.api+json",
        body: { data }
      });
      addedCount += data.length;
      chunks += 1;
    }
    return { addedCount, chunks };
  }

  async createQueuePlaylist(tracks = [], { title = "", description = "" } = {}) {
    const requested = Array.isArray(tracks) ? tracks.length : 0;
    const { refs, skipped } = uniqueTidalTrackRefs(tracks);
    if (!refs.length) {
      throw inputError("None of these tracks include TIDAL track IDs, so Rabbit Hole cannot create a TIDAL playlist from them.");
    }
    const playlist = await this.createPlaylist({
      title: title || queuePlaylistTitle(this.clock()),
      description: description || `Temporary Rabbit Hole queue created ${new Date(this.clock()).toISOString()}.`
    });
    const added = await this.addTracksToPlaylist(playlist.id, refs);
    this.cache = null;
    this.playlistCache = null;
    return {
      connected: true,
      requested,
      addableCount: refs.length,
      skippedCount: skipped.length,
      skipped,
      addedCount: added.addedCount,
      chunks: added.chunks,
      playlist,
      trackIds: refs.map((ref) => ref.id)
    };
  }

  async addTrackToPlaylist(playlistId = "", track = {}, { playlistTitle = "" } = {}) {
    const { refs, skipped } = uniqueTidalTrackRefs([track]);
    if (!refs.length) {
      throw inputError("The current track does not include a TIDAL track ID, so Rabbit Hole cannot add it to a TIDAL playlist.");
    }
    const added = await this.addTracksToPlaylist(playlistId, refs);
    this.playlistCache = null;
    return {
      connected: true,
      requested: 1,
      addableCount: refs.length,
      skippedCount: skipped.length,
      skipped,
      addedCount: added.addedCount,
      chunks: added.chunks,
      playlist: normalizeUserPlaylist({
        id: cleanText(playlistId),
        type: "playlists",
        attributes: {
          name: cleanText(playlistTitle)
        }
      }),
      track: {
        id: refs[0].id,
        title: refs[0].title,
        artist: refs[0].artist
      },
      trackIds: refs.map((ref) => ref.id)
    };
  }

  async fetchArtworkUrl(artworkId = "") {
    const id = cleanText(artworkId);
    if (!id) return "";
    try {
      const payload = await this.fetchOpenApiJson(`/artworks/${encodeURIComponent(id)}`, {
        countryCode: this.countryCode
      });
      return imageFromArtworkObject(payload.data);
    } catch {
      return "";
    }
  }

  artistSearchResult(payload = {}, artistName = "") {
    const target = normalizeText(artistName);
    if (!target) return null;
    const included = includedByTypeAndId(payload);
    const refs = Array.isArray(payload.data) ? payload.data : [];
    const artists = refs
      .map((ref) => included.get(`${ref.type}:${ref.id}`) || ref)
      .filter((artist) => artist?.type === "artists")
      .map((artist) => ({
        id: cleanText(artist.id),
        name: cleanText(artist.attributes?.name || artist.name),
        imageUrl: imageFromObject(artist)
      }))
      .filter((artist) => artist.id && artist.name);
    return artists.find((artist) => normalizeText(artist.name) === target) || null;
  }

  async resolveArtist(artistName = "") {
    const name = cleanText(artistName);
    if (!name) return null;
    const payload = await this.fetchOpenApiJson(`/searchResults/${encodeURIComponent(name)}/relationships/artists`, {
      countryCode: this.countryCode,
      include: "artists",
      limit: "10"
    });
    return this.artistSearchResult(payload, name);
  }

  async getArtistRadioMix(artistName = "") {
    const artist = await this.resolveArtist(artistName);
    if (!artist) return null;
    return this.getArtistRadioMixByArtistId(artist.id, { artistName: artist.name });
  }

  async getArtistRadioMixByArtistId(artistId = "", { artistName = "" } = {}) {
    const id = cleanText(artistId);
    if (!id) return null;
    const radioPayload = await this.fetchOpenApiJson(`/artists/${encodeURIComponent(id)}/relationships/radio`, {
      countryCode: this.countryCode,
      limit: "1"
    });
    const radioRef = Array.isArray(radioPayload.data)
      ? radioPayload.data.find((ref) => ref?.type === "playlists" && ref.id)
      : null;
    const playlistId = cleanText(radioRef?.id);
    if (!playlistId) return null;

    const playlistPath = `/playlists/${encodeURIComponent(playlistId)}`;
    const playlistParams = {
      countryCode: this.countryCode,
      include: "coverArt,items"
    };
    const playlist = await this.fetchOpenApiJson(playlistPath, playlistParams);
    const imageUrl = await this.fetchArtworkUrl(coverArtIdFromPlaylist(playlist));
    const mix = normalizeOfficialPlaylistMix({
      playlist,
      imageUrl,
      category: "Artist Radio",
      relationship: `artistRadio:${id}`
    });
    if (!mix) return null;
    return {
      ...mix,
      title: cleanText(artistName) || mix.title,
      subtitle: "Artist Radio",
      category: "Artist Radio",
      artistRadio: {
        artistId: id,
        artistName: cleanText(artistName) || mix.title
      },
      sourcePath: `/artists/${id}/relationships/radio`
    };
  }

  async getPlaylistMixById(playlistId = "", { category = "", relationship = "", sourceUrl = "" } = {}) {
    const id = cleanText(playlistId);
    if (!id) return null;
    if (!this.isConfigured()) throw new Error("TIDAL profile token missing. Connect TIDAL profile access first.");

    const playlistPath = `/playlists/${encodeURIComponent(id)}`;
    const playlist = await this.fetchOpenApiJson(playlistPath, {
      countryCode: this.countryCode,
      include: "coverArt,items"
    });
    const attributes = playlist?.data?.attributes || {};
    const inferredCategory = category || mixCategory(
      attributes.name || "",
      attributes.playlistType || "",
      attributes.description || ""
    );
    const imageUrl = await this.fetchArtworkUrl(coverArtIdFromPlaylist(playlist));
    const mix = normalizeOfficialPlaylistMix({
      playlist,
      imageUrl,
      category: inferredCategory,
      relationship: relationship || `playlist:${id}`
    });
    if (!mix) return null;
    return {
      ...mix,
      url: mix.url || cleanText(sourceUrl)
    };
  }

  async getPinnedMixes(entries = []) {
    const mixes = [];
    const errors = [];
    for (const entry of entries || []) {
      try {
        const kind = cleanText(entry.kind).toLowerCase();
        const mix = kind === "artist-radio"
          ? await this.getArtistRadioMixByArtistId(entry.id, { artistName: entry.title || "" })
          : await this.getPlaylistMixById(entry.id, {
            relationship: `pinned:${entry.kind || "playlist"}:${entry.id}`,
            sourceUrl: entry.sourceUrl || ""
          });
        if (!mix) {
          errors.push({
            key: entry.key || "",
            id: entry.id || "",
            sourceUrl: entry.sourceUrl || "",
            error: "TIDAL returned no playable mix metadata for this pinned item."
          });
          continue;
        }
        mixes.push({
          ...mix,
          pinned: true,
          pinnedKey: entry.key || "",
          pinnedKind: entry.kind || "playlist",
          sourceUrl: entry.sourceUrl || mix.url || "",
          importedAt: entry.createdAt || 0,
          url: mix.url || entry.sourceUrl || ""
        });
      } catch (error) {
        errors.push({
          key: entry.key || "",
          id: entry.id || "",
          sourceUrl: entry.sourceUrl || "",
          error: error.message
        });
      }
    }
    return { mixes, errors };
  }

  async getArtistRadioMixesFromSeeds(mixes = [], { limit = DEFAULT_ARTIST_RADIO_LIMIT } = {}) {
    const max = Math.max(0, Math.min(30, Number(limit || DEFAULT_ARTIST_RADIO_LIMIT)));
    if (!max) return [];
    const seeds = [];
    const seen = new Set();
    for (const mix of mixes) {
      for (const artistName of artistNamesFromMixSubtitle(mix?.subtitle)) {
        const key = normalizeText(artistName);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        seeds.push(artistName);
        if (seeds.length >= max) break;
      }
      if (seeds.length >= max) break;
    }

    const radios = [];
    for (const seed of seeds) {
      try {
        const radio = await this.getArtistRadioMix(seed);
        if (radio) radios.push(radio);
      } catch {
        // Artist radio is a best-effort fallback; failed seeds should not hide normal mixes.
      }
    }
    return radios;
  }

  async getOfficialMixes(now) {
    const recommendations = await this.fetchOpenApiJson("/userRecommendations/me", {
      include: RECOMMENDATION_RELATIONSHIPS.map((entry) => entry.key).join(","),
      locale: bcp47Locale(this.locale)
    });

    const attemptedEndpoints = [
      openApiUrl("/userRecommendations/me", {
        include: RECOMMENDATION_RELATIONSHIPS.map((entry) => entry.key).join(","),
        locale: bcp47Locale(this.locale)
      })
    ];
    const mixes = [];
    const seen = new Set();
    for (const relationship of RECOMMENDATION_RELATIONSHIPS) {
      for (const ref of relationshipRefs(recommendations, relationship.key)) {
        const id = cleanText(ref.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const playlistPath = `/playlists/${encodeURIComponent(id)}`;
        const playlistParams = {
          countryCode: this.countryCode,
          include: "coverArt,items"
        };
        attemptedEndpoints.push(openApiUrl(playlistPath, playlistParams));
        const playlist = await this.fetchOpenApiJson(playlistPath, playlistParams);
        const imageUrl = await this.fetchArtworkUrl(coverArtIdFromPlaylist(playlist));
        const mix = normalizeOfficialPlaylistMix({
          playlist,
          imageUrl,
          category: relationship.category,
          relationship: relationship.key
        });
        if (mix) mixes.push(mix);
      }
    }

    return {
      ...this.status(),
      connected: true,
      mixes,
      attemptedEndpoints,
      sourceEndpoint: attemptedEndpoints[0],
      fetchedAt: new Date(now).toISOString(),
      warning: mixes.length ? "" : "TIDAL responded, but no personal mix playlist ids were found in recommendations."
    };
  }

  async getMixTracks(mixId = "", { limit = 50, excludeTracks = [] } = {}) {
    const id = cleanText(mixId);
    if (!id) throw new Error("Missing TIDAL mix id.");
    if (!this.isConfigured()) throw new Error("TIDAL profile token missing. Connect TIDAL profile access first.");

    const safeLimit = Math.max(1, Math.min(50, Number(limit || 50)));
    const excluded = Array.isArray(excludeTracks) ? excludeTracks : [];
    const fetchLimit = excluded.length
      ? Math.max(safeLimit, Math.min(50, safeLimit + Math.max(10, excluded.length)))
      : safeLimit;
    const playlistPath = `/playlists/${encodeURIComponent(id)}`;
    const playlist = await this.fetchOpenApiJson(playlistPath, {
      countryCode: this.countryCode,
      include: "coverArt,items"
    });
    const imageUrl = await this.fetchArtworkUrl(coverArtIdFromPlaylist(playlist));
    const mix = normalizeOfficialPlaylistMix({
      playlist,
      imageUrl,
      category: mixCategory(playlist?.data?.attributes?.name || "", playlist?.data?.attributes?.playlistType || "", playlist?.data?.attributes?.description || ""),
      relationship: "items"
    });

    const tracks = [];
    let cursor = "";
    let page = 0;
    const attemptedEndpoints = [];
    do {
      const params = {
        countryCode: this.countryCode,
        include: "items,items.artists,items.albums"
      };
      if (cursor) params["page[cursor]"] = cursor;
      const itemsPath = `/playlists/${encodeURIComponent(id)}/relationships/items`;
      attemptedEndpoints.push(openApiUrl(itemsPath, params));
      const payload = await this.fetchOpenApiJson(itemsPath, params);
      tracks.push(...normalizeOfficialPlaylistTracks(payload, { mix }));
      const next = cleanText(payload?.links?.next);
      cursor = "";
      if (next && tracks.length < fetchLimit) {
        try {
          const nextUrl = new URL(next, TIDAL_OPENAPI_ROOT);
          cursor = cleanText(nextUrl.searchParams.get("page[cursor]"));
        } catch {
          cursor = "";
        }
      }
      page += 1;
    } while (cursor && tracks.length < fetchLimit && page < 5);

    const filtered = filterExcludedTracks(tracks, excluded);
    const selectedTracks = filtered.tracks.slice(0, safeLimit);

    return {
      connected: true,
      mix,
      requested: safeLimit,
      fetchedCount: tracks.length,
      excludedCount: filtered.excludedCount,
      count: selectedTracks.length,
      tracks: selectedTracks,
      attemptedEndpoints
    };
  }

  async getFreshArtistRadioTracks(artistId = "", { limit = 20, excludeTracks = [] } = {}) {
    const id = cleanText(artistId);
    if (!id) throw new Error("Missing TIDAL artist radio id.");
    const requestedLimit = Math.max(1, Math.min(50, Number(limit || 20)));
    const radio = await this.getArtistRadioMixByArtistId(id);
    if (!radio?.id) throw new Error("TIDAL did not return a playable Artist Radio playlist for this artist.");

    const result = await this.getMixTracks(radio.id, {
      limit: requestedLimit,
      excludeTracks
    });
    return {
      ...result,
      mix: {
        ...(result.mix || {}),
        ...radio,
        id: radio.id,
        category: "Artist Radio",
        subtitle: radio.subtitle || "Artist Radio"
      },
      requested: requestedLimit,
      freshArtistRadio: true,
      artistRadioArtistId: id
    };
  }

  async getLegacyEndpointMixes(now) {
    const attempts = [];
    let successfulEmpty = null;
    for (const endpoint of this.endpoints()) {
      try {
        const payload = await this.fetchJson(endpoint);
        const mixes = normalizeTidalMixesPayload(payload);
        const result = {
          ...this.status(),
          connected: true,
          mixes,
          attemptedEndpoints: [...attempts, endpoint],
          sourceEndpoint: endpoint,
          fetchedAt: new Date(now).toISOString(),
          warning: mixes.length ? "" : "TIDAL responded, but no personal mix objects were found in the payload."
        };
        if (mixes.length) return result;
        successfulEmpty = result;
      } catch (error) {
        attempts.push(`${endpoint} -> ${error.message}`);
      }
    }

    if (successfulEmpty) return successfulEmpty;

    return {
      ...this.status(),
      connected: false,
      mixes: [],
      attemptedEndpoints: attempts,
      error: attempts.at(-1) || "No TIDAL profile mix endpoint returned data."
    };
  }

  async getMixes({ force = false } = {}) {
    const status = this.status();
    if (!this.enabled) {
      return { ...status, connected: false, mixes: [], error: "TIDAL profile mixes are disabled." };
    }
    if (!this.isConfigured()) {
      return {
        ...status,
        connected: false,
        mixes: [],
        error: "TIDAL profile token missing. Add TIDAL_PROFILE_ACCESS_TOKEN to read personal mixes."
      };
    }

    const now = this.clock();
    if (!force && this.cache?.result && this.cacheMs && now - this.cache.fetchedAtMs < this.cacheMs) {
      return this.cache.result;
    }

    const useLegacyOverride = Boolean(configuredEndpoints(this.endpoint).length);
    if (useLegacyOverride) {
      const result = await this.getLegacyEndpointMixes(now);
      this.cache = {
        result,
        fetchedAtMs: now,
        fetchedAt: result.fetchedAt || "",
        error: result.error || result.warning || ""
      };
      return result;
    }

    let officialResult = null;
    try {
      officialResult = await this.getOfficialMixes(now);
    } catch (error) {
      officialResult = {
        ...this.status(),
        connected: false,
        mixes: [],
        attemptedEndpoints: [`${openApiUrl("/userRecommendations/me")} -> ${error.message}`],
        error: error.message
      };
    }

    const fullShelfScopeAvailable = this.hasFullMixesScope();
    if (!fullShelfScopeAvailable) {
      const artistRadios = officialResult.connected && this.artistRadioFallback
        ? await this.getArtistRadioMixesFromSeeds(officialResult.mixes)
        : [];
      const mixes = mergeMixLists(officialResult.mixes, artistRadios);
      const result = {
        ...officialResult,
        mixes,
        fullShelfAvailable: false,
        missingLegacyScope: FULL_MIXES_SCOPE,
        artistRadioFallbackAvailable: Boolean(artistRadios.length),
        artistRadioFallbackCount: artistRadios.length,
        warning: officialResult.warning || (artistRadios.length
          ? "Full TIDAL shelf is blocked by a legacy scope; added Artist Radio cards from official mix artists."
          : "TIDAL's full Mixes & Radio shelf requires a legacy profile scope that normal OAuth may not grant. Showing only official TIDAL profile mixes.")
      };
      this.cache = { result, fetchedAtMs: now, fetchedAt: result.fetchedAt || "", error: result.error || result.warning || "" };
      return result;
    }

    const legacyResult = await this.getLegacyEndpointMixes(now);
    if (legacyResult.connected && legacyResult.mixes.length) {
      const result = {
        ...officialResult,
        connected: true,
        mixes: mergeMixLists(officialResult.mixes, legacyResult.mixes),
        attemptedEndpoints: [
          ...(officialResult.attemptedEndpoints || []),
          ...(legacyResult.attemptedEndpoints || [])
        ],
        sourceEndpoint: officialResult.sourceEndpoint || legacyResult.sourceEndpoint,
        legacySourceEndpoint: legacyResult.sourceEndpoint,
        fetchedAt: officialResult.fetchedAt || legacyResult.fetchedAt || new Date(now).toISOString(),
        fullShelfAvailable: true,
        missingLegacyScope: "",
        legacyError: "",
        warning: ""
      };
      this.cache = { result, fetchedAtMs: now, fetchedAt: result.fetchedAt || "", error: "" };
      return result;
    }

    if (!officialResult.connected && legacyResult.connected) {
      const result = {
        ...legacyResult,
        fullShelfAvailable: true,
        legacySourceEndpoint: legacyResult.sourceEndpoint
      };
      this.cache = { result, fetchedAtMs: now, fetchedAt: result.fetchedAt || "", error: result.error || result.warning || "" };
      return result;
    }

    const result = {
      ...officialResult,
      fullShelfAvailable: false,
      legacyError: legacyResult.error || legacyResult.warning || "Full Mixes & Radio shelf returned no items.",
      warning: officialResult.warning || `Full Mixes & Radio unavailable: ${legacyResult.error || legacyResult.warning || "no items returned"}`
    };
    this.cache = {
      result,
      fetchedAtMs: now,
      fetchedAt: result.fetchedAt || "",
      error: result.error || result.warning || ""
    };
    return result;
  }
}

module.exports = {
  TidalProfileMixes,
  normalizeOfficialPlaylistTracks,
  normalizeTidalMixesPayload
};
