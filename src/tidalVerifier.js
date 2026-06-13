"use strict";

const USER_AGENT = "RoonLocalAI/0.1.0";
const TIDAL_TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";
const TIDAL_SEARCH_ROOT = "https://openapi.tidal.com/v2/searchResults";
const TIDAL_TRACK_ROOT = "https://openapi.tidal.com/v2/tracks";
const TIDAL_LEGACY_SEARCH_URL = "https://api.tidal.com/v1/search/tracks";
const TIDAL_FETCH_TIMEOUT_MS = 12_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TIDAL_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("TIDAL lookup timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeMatchText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeSearchQuery(value) {
  return cleanText(value)
    .replace(/&/g, " ")
    .replace(/[^a-z0-9()]+/gi, " ")
    .trim();
}

function getArtistLookupAliases(value) {
  const artist = cleanText(value);
  if (!artist) return [];

  const aliases = [artist];
  for (const part of artist.split(/\s*(?:,|;|\/|&|\+|\band\b)\s*/i)) {
    const cleanPart = cleanText(part);
    if (cleanPart) aliases.push(cleanPart);
  }

  return Array.from(new Set(aliases));
}

function stripMixVersionSuffix(value) {
  return cleanText(value)
    .replace(/\s*\((?:[^)]*\b(?:mix|remix|edit|version|extended|original|radio|dub|instrumental|club|vip)\b[^)]*)\)\s*$/i, "")
    .replace(/\s*-\s*(?:extended|original|radio|club|dub|instrumental)\s+(?:mix|edit|version)\s*$/i, "")
    .trim();
}

function stripGuestCredit(value) {
  return cleanText(value)
    .replace(/\s*[\[(]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^\])]+[\])]\s*/gi, " ")
    .replace(/\s+-\s+(?:feat\.?|ft\.?|featuring|with)\s+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getTitleMatchKeys(value) {
  return Array.from(new Set([
    normalizeMatchText(value),
    normalizeMatchText(stripMixVersionSuffix(value))
  ].filter(Boolean)));
}

function titleKeysMatch(leftKeys, rightKeys) {
  return leftKeys.some((left) => rightKeys.some((right) => left === right || left.includes(right) || right.includes(left)));
}

function createSearchQueries(track, { strict = false } = {}) {
  const searches = [];
  const baseTitle = stripMixVersionSuffix(track.title);
  const guestlessTitle = stripGuestCredit(track.title);
  const guestlessBaseTitle = stripMixVersionSuffix(guestlessTitle);
  const artistAliases = getArtistLookupAliases(track.artist);
  const normalizedArtist = normalizeSearchQuery(track.artist);
  const normalizedTitle = normalizeSearchQuery(track.title);
  const normalizedBaseTitle = normalizeSearchQuery(baseTitle);
  const normalizedGuestlessTitle = normalizeSearchQuery(guestlessTitle);
  const normalizedGuestlessBaseTitle = normalizeSearchQuery(guestlessBaseTitle);

  for (const artist of artistAliases) searches.push(`${artist} ${track.title}`);
  for (const artist of artistAliases) searches.push(`${track.title} ${artist}`);
  if (normalizedArtist && normalizedTitle) searches.push(`${normalizedArtist} ${normalizedTitle}`);
  if (normalizedArtist && normalizedTitle) searches.push(`${normalizedTitle} ${normalizedArtist}`);

  if (strict) {
    return Array.from(new Set(searches.map(cleanText).filter(Boolean))).slice(0, 4);
  }

  if (baseTitle && baseTitle !== track.title) for (const artist of artistAliases) searches.push(`${artist} ${baseTitle}`);
  if (baseTitle && baseTitle !== track.title) for (const artist of artistAliases) searches.push(`${baseTitle} ${artist}`);
  if (normalizedArtist && normalizedBaseTitle && normalizedBaseTitle !== normalizedTitle) searches.push(`${normalizedArtist} ${normalizedBaseTitle}`);
  if (normalizedArtist && normalizedBaseTitle && normalizedBaseTitle !== normalizedTitle) searches.push(`${normalizedBaseTitle} ${normalizedArtist}`);
  if (guestlessTitle && guestlessTitle !== track.title) for (const artist of artistAliases) searches.push(`${artist} ${guestlessTitle}`);
  if (guestlessTitle && guestlessTitle !== track.title) for (const artist of artistAliases) searches.push(`${guestlessTitle} ${artist}`);
  if (guestlessBaseTitle && guestlessBaseTitle !== baseTitle && guestlessBaseTitle !== guestlessTitle) for (const artist of artistAliases) searches.push(`${artist} ${guestlessBaseTitle}`);
  if (guestlessBaseTitle && guestlessBaseTitle !== baseTitle && guestlessBaseTitle !== guestlessTitle) for (const artist of artistAliases) searches.push(`${guestlessBaseTitle} ${artist}`);
  if (normalizedArtist && normalizedGuestlessTitle && normalizedGuestlessTitle !== normalizedTitle) searches.push(`${normalizedArtist} ${normalizedGuestlessTitle}`);
  if (normalizedArtist && normalizedGuestlessTitle && normalizedGuestlessTitle !== normalizedTitle) searches.push(`${normalizedGuestlessTitle} ${normalizedArtist}`);
  if (normalizedArtist && normalizedGuestlessBaseTitle && normalizedGuestlessBaseTitle !== normalizedBaseTitle && normalizedGuestlessBaseTitle !== normalizedGuestlessTitle) searches.push(`${normalizedArtist} ${normalizedGuestlessBaseTitle}`);
  if (normalizedArtist && normalizedGuestlessBaseTitle && normalizedGuestlessBaseTitle !== normalizedBaseTitle && normalizedGuestlessBaseTitle !== normalizedGuestlessTitle) searches.push(`${normalizedGuestlessBaseTitle} ${normalizedArtist}`);
  searches.push(track.title);
  if (baseTitle && baseTitle !== track.title) searches.push(baseTitle);
  if (guestlessTitle && guestlessTitle !== track.title) searches.push(guestlessTitle);
  if (guestlessBaseTitle && guestlessBaseTitle !== baseTitle && guestlessBaseTitle !== guestlessTitle) searches.push(guestlessBaseTitle);

  return Array.from(new Set(searches.map(cleanText).filter(Boolean)));
}

function getRelationshipData(item, name) {
  const data = item?.relationships?.[name]?.data;
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

function getIncluded(searchJson, type) {
  const included = Array.isArray(searchJson?.included) ? searchJson.included : [];
  return included.filter((entry) => cleanText(entry?.type) === type);
}

function findIncluded(searchJson, ref, type) {
  const wantedType = cleanText(ref?.type || type);
  const wantedId = cleanText(ref?.id);
  if (!wantedId) return null;
  return getIncluded(searchJson, wantedType).find((entry) => cleanText(entry?.id) === wantedId) || null;
}

function getItems(searchJson) {
  if (Array.isArray(searchJson?.items)) return searchJson.items;
  if (Array.isArray(searchJson?.tracks?.items)) return searchJson.tracks.items;

  const data = Array.isArray(searchJson?.data) ? searchJson.data : (searchJson?.data ? [searchJson.data] : []);
  const dataTracks = data.filter((entry) => cleanText(entry?.type) === "tracks" || entry?.attributes?.title || entry?.title);
  if (dataTracks.length) {
    return dataTracks.map((entry) => findIncluded(searchJson, entry, "tracks") || entry);
  }

  return getIncluded(searchJson, "tracks");
}

function getArtistNames(item = {}, searchJson = {}) {
  const artists = Array.isArray(item.artists) ? item.artists : [];
  const flatNames = artists.map((artist) => cleanText(artist?.name)).filter(Boolean);
  if (flatNames.length) return flatNames;

  const relationshipNames = getRelationshipData(item, "artists")
    .map((ref) => findIncluded(searchJson, ref, "artists"))
    .map((artist) => cleanText(artist?.attributes?.name || artist?.name))
    .filter(Boolean);
  if (relationshipNames.length) return relationshipNames;

  return [cleanText(item.artist?.name || item.attributes?.artistName)].filter(Boolean);
}

function getAlbum(item = {}, searchJson = {}) {
  const flatAlbum = item.album || {};
  if (flatAlbum.title || flatAlbum.attributes?.title) return flatAlbum;

  const ref = getRelationshipData(item, "albums")[0] || getRelationshipData(item, "album")[0];
  return findIncluded(searchJson, ref, "albums") || {};
}

function normalizeTidalTrackUrl(value) {
  const url = cleanText(value);
  const trackMatch = url.match(/^https?:\/\/(?:www\.)?(?:listen\.)?tidal\.com\/(?:browse\/)?track\/(\d+)/i);
  if (trackMatch) return `https://tidal.com/browse/track/${trackMatch[1]}`;
  return url;
}

function getExternalLink(item = {}) {
  const links = Array.isArray(item.attributes?.externalLinks) ? item.attributes.externalLinks : [];
  return cleanText(links.find((link) => link?.meta?.type === "TIDAL_SHARING")?.href || links[0]?.href);
}

function imageUrlFromTidalId(value, size = 640) {
  const id = cleanText(value);
  if (/^https?:\/\//i.test(id)) return id;
  if (!/^[a-f0-9-]{32,36}$/i.test(id)) return "";
  const path = id.replace(/-/g, "/");
  return `https://resources.tidal.com/images/${path}/${size}x${size}.jpg`;
}

function imageUrlFromLinks(value) {
  if (!value) return "";
  const links = Array.isArray(value) ? value : Object.values(value).flat();
  return links
    .map((link) => {
      if (typeof link === "string") return link;
      return cleanText(link?.href || link?.url || link?.imageUrl);
    })
    .filter((href) => /^https?:\/\//i.test(href))
    .sort((left, right) => right.length - left.length)[0] || "";
}

function getImageUrl(item = {}, album = {}) {
  const linkUrl = imageUrlFromLinks(album.imageLinks || album.attributes?.imageLinks || item.imageLinks || item.attributes?.imageLinks);
  if (linkUrl) return linkUrl;

  const candidates = [
    album.cover,
    album.attributes?.cover,
    album.imageId,
    album.attributes?.imageId,
    album.attributes?.coverArt,
    album.attributes?.imageCover,
    item.cover,
    item.attributes?.cover,
    item.imageId,
    item.attributes?.imageId
  ];

  for (const candidate of candidates) {
    const imageUrl = imageUrlFromTidalId(candidate);
    if (imageUrl) return imageUrl;
  }

  return "";
}

function getTidalTrackUrl(item = {}) {
  const directUrl = cleanText(item.url || item.shareUrl || item.attributes?.url || item.attributes?.shareUrl);
  if (/^https?:\/\//i.test(directUrl)) return normalizeTidalTrackUrl(directUrl);
  const externalLink = getExternalLink(item);
  if (externalLink) return normalizeTidalTrackUrl(externalLink);
  const id = cleanText(item.id);
  return /^\d+$/.test(id) ? `https://tidal.com/browse/track/${id}` : "";
}

function isTidalTrackMatch(item = {}, track = {}, searchJson = {}, { strict = false } = {}) {
  const resultTitleKeys = getTitleMatchKeys(item.title || item.attributes?.title);
  const trackTitleKeys = getTitleMatchKeys(track.title);
  const trackArtists = getArtistLookupAliases(track.artist).map(normalizeMatchText).filter(Boolean);
  const resultArtist = normalizeMatchText(getArtistNames(item, searchJson).join(" "));

  if (!resultTitleKeys.length || !trackTitleKeys.length) return false;
  if (strict) {
    if (!trackTitleKeys.some((trackTitle) => resultTitleKeys.includes(trackTitle))) return false;
  } else if (!titleKeysMatch(resultTitleKeys, trackTitleKeys)) {
    return false;
  }
  if (trackArtists.length && resultArtist && !trackArtists.some((artist) => resultArtist.includes(artist) || artist.includes(resultArtist))) return false;
  return true;
}

function chooseCandidate(searchJson, track = {}, options = {}) {
  return getItems(searchJson).find((entry) => isTidalTrackMatch(entry, track, searchJson, options)) || null;
}

function yearFromValue(value) {
  const match = cleanText(value).match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function dateFromValue(value) {
  const match = cleanText(value).match(/\b((19|20)\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getIsrcYear(item = {}) {
  const isrc = cleanText(item.isrc || item.attributes?.isrc).replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc)) return null;
  const shortYear = Number(isrc.slice(5, 7));
  return shortYear <= 39 ? 2000 + shortYear : 1900 + shortYear;
}

function firstYear(values) {
  for (const value of values) {
    const year = yearFromValue(value);
    if (year) return year;
  }
  return null;
}

function firstDate(values) {
  for (const value of values) {
    const date = dateFromValue(value);
    if (date) return date;
  }
  return "";
}

function getReleaseYear(item = {}, album = {}) {
  const albumYear = firstYear([
    album.originalReleaseDate,
    album.attributes?.originalReleaseDate,
    album.releaseDate,
    album.attributes?.releaseDate,
    album.releaseYear,
    album.attributes?.releaseYear,
    album.releaseDateTime,
    album.attributes?.releaseDateTime
  ]);
  const trackReleaseYear = firstYear([
    item.originalReleaseDate,
    item.attributes?.originalReleaseDate,
    item.releaseDate,
    item.attributes?.releaseDate,
    item.releaseYear,
    item.attributes?.releaseYear,
    item.releaseDateTime,
    item.attributes?.releaseDateTime
  ]);
  const isrcYear = getIsrcYear(item);

  const canonicalYears = [albumYear, trackReleaseYear, isrcYear].filter(Boolean);
  if (canonicalYears.length) return Math.min(...canonicalYears);

  return firstYear([
    item.streamStartDate,
    item.attributes?.streamStartDate,
    album.streamStartDate,
    album.attributes?.streamStartDate
  ]);
}

function getReleaseDate(item = {}, album = {}) {
  const albumDate = firstDate([
    album.originalReleaseDate,
    album.attributes?.originalReleaseDate,
    album.releaseDate,
    album.attributes?.releaseDate,
    album.releaseDateTime,
    album.attributes?.releaseDateTime
  ]);
  const trackReleaseDate = firstDate([
    item.originalReleaseDate,
    item.attributes?.originalReleaseDate,
    item.releaseDate,
    item.attributes?.releaseDate,
    item.releaseDateTime,
    item.attributes?.releaseDateTime
  ]);

  const canonicalDates = [albumDate, trackReleaseDate].filter(Boolean).sort();
  if (canonicalDates.length) return canonicalDates[0];

  return firstDate([
    item.streamStartDate,
    item.attributes?.streamStartDate,
    album.streamStartDate,
    album.attributes?.streamStartDate
  ]);
}

function getReleaseEvidence(item = {}, album = {}) {
  return {
    albumDate: firstDate([
      album.originalReleaseDate,
      album.attributes?.originalReleaseDate,
      album.releaseDate,
      album.attributes?.releaseDate,
      album.releaseDateTime,
      album.attributes?.releaseDateTime
    ]),
    albumYear: firstYear([
      album.originalReleaseDate,
      album.attributes?.originalReleaseDate,
      album.releaseDate,
      album.attributes?.releaseDate,
      album.releaseYear,
      album.attributes?.releaseYear,
      album.releaseDateTime,
      album.attributes?.releaseDateTime
    ]),
    trackDate: firstDate([
      item.originalReleaseDate,
      item.attributes?.originalReleaseDate,
      item.releaseDate,
      item.attributes?.releaseDate,
      item.releaseDateTime,
      item.attributes?.releaseDateTime
    ]),
    trackYear: firstYear([
      item.originalReleaseDate,
      item.attributes?.originalReleaseDate,
      item.releaseDate,
      item.attributes?.releaseDate,
      item.releaseYear,
      item.attributes?.releaseYear,
      item.releaseDateTime,
      item.attributes?.releaseDateTime
    ]),
    isrcYear: getIsrcYear(item),
    streamStartDate: firstDate([
      item.streamStartDate,
      item.attributes?.streamStartDate,
      album.streamStartDate,
      album.attributes?.streamStartDate
    ]),
    streamStartYear: firstYear([
      item.streamStartDate,
      item.attributes?.streamStartDate,
      album.streamStartDate,
      album.attributes?.streamStartDate
    ]),
    createdDate: firstDate([
      item.createdAt,
      item.attributes?.createdAt,
      album.createdAt,
      album.attributes?.createdAt
    ]),
    createdYear: firstYear([
      item.createdAt,
      item.attributes?.createdAt,
      album.createdAt,
      album.attributes?.createdAt
    ])
  };
}

function copyrightText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(copyrightText).filter(Boolean).join("; ");
  if (typeof value === "object") {
    return cleanText(value.text || value.name || value.label || value.value || value.title);
  }
  return cleanText(value);
}

function cleanLabel(value) {
  return copyrightText(value)
    .replace(/[©℗]/g, " ")
    .replace(/\([cp]\)/gi, " ")
    .replace(/\b(?:copyright|phonographic copyright|under exclusive license to|exclusively licensed to|licensed to|distributed by|a division of)\b/gi, " ")
    .replace(/\b(19\d{2}|20\d{2})\b/g, " ")
    .replace(/\ball rights reserved\b/gi, " ")
    .replace(/\s*[.,;:|-]\s*$/g, "")
    .replace(/^\s*[.,;:|-]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getLabel(item = {}, album = {}) {
  const candidates = [
    album.label,
    album.attributes?.label,
    album.attributes?.copyright,
    album.attributes?.copyrights,
    album.copyright,
    album.copyrights,
    item.label,
    item.attributes?.label,
    item.attributes?.copyright,
    item.attributes?.copyrights,
    item.copyright,
    item.copyrights
  ];

  for (const candidate of candidates) {
    const label = cleanLabel(candidate);
    if (label) return label;
  }

  return "";
}

function getDurationMs(item = {}) {
  const values = [
    item.durationMs,
    item.duration,
    item.attributes?.durationMs,
    item.attributes?.duration,
    item.attributes?.durationSeconds
  ];

  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1000 ? Math.round(value) : Math.round(value * 1000);
    }

    const text = cleanText(value);
    const iso = text.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (iso) {
      return ((Number(iso[1] || 0) * 3600) + (Number(iso[2] || 0) * 60) + Number(iso[3] || 0)) * 1000;
    }

    if (/^\d+$/.test(text)) {
      const number = Number(text);
      return number > 1000 ? number : number * 1000;
    }
  }

  return null;
}

function extractReleaseMetadataFromHtml(html) {
  const text = cleanText(html);
  const datePatterns = [
    /"releaseDate"\s*:\s*"((?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2})/i,
    /"releaseDateTime"\s*:\s*"((?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2})/i,
    /"datePublished"\s*:\s*"((?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2})/i
  ];

  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    const releaseDate = match ? dateFromValue(match[1]) : "";
    if (releaseDate) return { releaseDate, year: Number(releaseDate.slice(0, 4)) };
  }

  const patterns = [
    /"releaseDate"\s*:\s*"((?:19|20)\d{2})[-"]/i,
    /"releaseDateTime"\s*:\s*"((?:19|20)\d{2})[-"]/i,
    /"datePublished"\s*:\s*"((?:19|20)\d{2})[-"]/i,
    /"copyright"\s*:\s*"[^"]*\b((?:19|20)\d{2})\b/i,
    />\s*((?:19|20)\d{2})\s*</i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { releaseDate: "", year: Number(match[1]) };
  }

  return { releaseDate: "", year: null };
}

function buildResult(item, searchJson, query) {
  const album = getAlbum(item, searchJson);
  return {
    verified: true,
    id: cleanText(item.id),
    query,
    title: cleanText(item.title || item.attributes?.title),
    artist: cleanText(getArtistNames(item, searchJson).join(", ")),
    album: cleanText(album.title || album.attributes?.title),
    label: getLabel(item, album),
    year: getReleaseYear(item, album),
    releaseDate: getReleaseDate(item, album),
    releaseEvidence: getReleaseEvidence(item, album),
    durationMs: getDurationMs(item),
    imageUrl: getImageUrl(item, album),
    tidalUrl: getTidalTrackUrl(item),
    source: "tidal"
  };
}

function getTrackIdFromUrl(value) {
  const match = cleanText(value).match(/\/track\/(\d+)/i);
  return match ? match[1] : "";
}

function chooseExactArtist(searchJson, artistName) {
  const wanted = normalizeMatchText(artistName);
  if (!wanted) return null;
  return getIncluded(searchJson, "artists").find((artist) => normalizeMatchText(artist?.attributes?.name || artist?.name) === wanted) || null;
}

class TidalVerifier {
  constructor(config = {}) {
    this.enabled = !!config.enabled;
    this.countryCode = config.countryCode || "US";
    this.clientId = config.clientId || "";
    this.clientSecret = config.clientSecret || "";
    this.accessToken = config.accessToken || "";
    this.token = null;
    this.cache = new Map();
    this.nextRequestAt = 0;
  }

  isConfigured() {
    return Boolean(this.enabled && (this.accessToken || (this.clientId && this.clientSecret)));
  }

  async verify(track, { strict = false } = {}) {
    if (!this.isConfigured()) return null;
    const cacheKey = `${strict ? "strict" : "loose"}:${normalizeMatchText(track.artist)}|${normalizeMatchText(track.title)}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    let lastError = null;

    for (const query of createSearchQueries(track, { strict })) {
      let result = null;
      try {
        result = await this.searchV2(track, query, { strict });
      } catch (error) {
        lastError = error;
      }

      if (!result && !strict) {
        try {
          result = await this.searchLegacy(track, query, { strict });
        } catch (error) {
          lastError = error;
        }
      }
      if (result) {
        const verified = await this.withPageYear(await this.withDetailYear(result));
        this.cache.set(cacheKey, verified);
        return verified;
      }
    }

    if (lastError) {
      const error = new Error(lastError.message || "TIDAL lookup failed");
      error.source = "tidal";
      throw error;
    }

    this.cache.set(cacheKey, null);
    return null;
  }

  async searchTracks(query, { limit = 10, detailLimit = 3 } = {}) {
    if (!this.isConfigured()) return [];
    const normalizedLimit = Math.max(1, Math.min(20, Number(limit || 10)));
    const normalizedDetailLimit = Math.max(0, Math.min(normalizedLimit, Number(detailLimit || 0)));
    const cacheKey = `catalog:${normalizeMatchText(query)}:${normalizedLimit}:${normalizedDetailLimit}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const searchUrl = new URL(`${TIDAL_SEARCH_ROOT}/${encodeURIComponent(query)}/relationships/tracks`);
    searchUrl.searchParams.set("countryCode", this.countryCode);
    searchUrl.searchParams.set("include", "tracks,albums,artists");
    searchUrl.searchParams.set("limit", String(normalizedLimit));

    const searchJson = await this.fetchTidalJson(searchUrl.toString());
    const results = [];
    let index = 0;
    for (const item of getItems(searchJson).slice(0, normalizedLimit)) {
      const result = buildResult(item, searchJson, query);
      if (!result.title || !result.tidalUrl) continue;
      const enriched = index < normalizedDetailLimit ? await this.withDetailYear(result) : result;
      if (!enriched.title || !enriched.artist || !enriched.tidalUrl) continue;
      results.push(enriched);
      index += 1;
    }

    this.cache.set(cacheKey, results);
    return results;
  }

  async resolveArtist(artistName) {
    if (!this.isConfigured()) return null;
    const cacheKey = `artist:${normalizeMatchText(artistName)}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const searchUrl = new URL(`${TIDAL_SEARCH_ROOT}/${encodeURIComponent(artistName)}/relationships/artists`);
    searchUrl.searchParams.set("countryCode", this.countryCode);
    searchUrl.searchParams.set("include", "artists");
    searchUrl.searchParams.set("limit", "20");

    const searchJson = await this.fetchTidalJson(searchUrl.toString());
    const artist = chooseExactArtist(searchJson, artistName);
    const result = artist ? {
      id: cleanText(artist.id),
      name: cleanText(artist.attributes?.name || artist.name)
    } : null;

    this.cache.set(cacheKey, result);
    return result;
  }

  async getArtistAlbums(artistName, { limit = 8 } = {}) {
    const artist = await this.resolveArtist(artistName);
    if (!artist?.id) return [];

    const normalizedLimit = Math.max(1, Math.min(20, Number(limit || 8)));
    const cacheKey = `artist-albums:${artist.id}:${normalizedLimit}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const albumsUrl = new URL(`https://openapi.tidal.com/v2/artists/${encodeURIComponent(artist.id)}/relationships/albums`);
    albumsUrl.searchParams.set("countryCode", this.countryCode);
    albumsUrl.searchParams.set("include", "albums");
    albumsUrl.searchParams.set("limit", String(normalizedLimit));

    const albumsJson = await this.fetchTidalJson(albumsUrl.toString());
    const albums = getIncluded(albumsJson, "albums").map((album) => ({
      id: cleanText(album.id),
      title: cleanText(album.attributes?.title || album.title),
      label: getLabel({}, album),
      year: getReleaseYear({}, album),
      releaseDate: getReleaseDate({}, album),
      releaseEvidence: getReleaseEvidence({}, album),
      artist: artist.name
    })).filter((album) => album.id && album.title);

    this.cache.set(cacheKey, albums);
    return albums;
  }

  async getAlbumTracks(album, { limit = 12 } = {}) {
    if (!album?.id) return [];
    const normalizedLimit = Math.max(1, Math.min(30, Number(limit || 12)));
    const cacheKey = `album-tracks:${album.id}:${normalizedLimit}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const itemsUrl = new URL(`https://openapi.tidal.com/v2/albums/${encodeURIComponent(album.id)}/relationships/items`);
    itemsUrl.searchParams.set("countryCode", this.countryCode);
    itemsUrl.searchParams.set("include", "tracks,albums,artists");
    itemsUrl.searchParams.set("limit", String(normalizedLimit));

    const itemsJson = await this.fetchTidalJson(itemsUrl.toString());
    const includedTracks = getIncluded(itemsJson, "tracks");
    if (includedTracks.length) {
      const tracks = includedTracks
        .slice(0, normalizedLimit)
        .map((item) => buildResult(item, itemsJson, `${album.artist} ${album.title}`))
        .filter((track) => track.title && track.artist && track.tidalUrl);
      if (tracks.length) {
        this.cache.set(cacheKey, tracks);
        return tracks;
      }
    }

    const refs = Array.isArray(itemsJson?.data) ? itemsJson.data.filter((item) => item?.type === "tracks") : [];
    const tracks = [];

    for (const ref of refs.slice(0, normalizedLimit)) {
      const detail = await this.getTrack(ref.id, `${album.artist} ${album.title}`);
      if (detail) tracks.push(detail);
    }

    this.cache.set(cacheKey, tracks);
    return tracks;
  }

  async getTrack(trackId, query = "") {
    const id = cleanText(trackId);
    if (!id) return null;
    const cacheKey = `track:${id}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const result = await this.withDetailYear({
      verified: true,
      id,
      query,
      title: "",
      artist: "",
      album: "",
      year: null,
      releaseDate: "",
      releaseEvidence: {},
      durationMs: null,
      label: "",
      tidalUrl: `https://tidal.com/browse/track/${id}`,
      source: "tidal"
    });

    const finalResult = result.title && result.artist ? result : null;
    this.cache.set(cacheKey, finalResult);
    return finalResult;
  }

  async withPageYear(result) {
    if ((result.year && result.releaseDate) || !result.tidalUrl) return result;

    try {
      const response = await fetchWithTimeout(result.tidalUrl, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": USER_AGENT
        }
      });
      if (!response.ok) return result;

      const metadata = extractReleaseMetadataFromHtml(await response.text());
      return metadata.year ? {
        ...result,
        year: result.year || metadata.year,
        releaseDate: result.releaseDate || metadata.releaseDate || "",
        yearSource: "tidal-web"
      } : result;
    } catch {
      return result;
    }
  }

  async withDetailYear(result) {
    const evidence = result.releaseEvidence || {};
    if (result.year && result.releaseDate && result.artist && result.album && result.durationMs && (evidence.albumYear || evidence.trackYear || evidence.isrcYear)) {
      return result;
    }

    const trackId = getTrackIdFromUrl(result.tidalUrl);
    if (!trackId) return result;

    try {
      const detailUrl = new URL(`${TIDAL_TRACK_ROOT}/${encodeURIComponent(trackId)}`);
      detailUrl.searchParams.set("countryCode", this.countryCode);
      detailUrl.searchParams.set("include", "albums,artists");
      const detailJson = await this.fetchTidalJson(detailUrl.toString());
      const track = detailJson?.data || {};
      const album = getAlbum(track, detailJson);
      const year = getReleaseYear(track, album);
      const releaseDate = getReleaseDate(track, album);
      const artist = cleanText(getArtistNames(track, detailJson).join(", "));

      return {
        ...result,
        title: cleanText(track.title || track.attributes?.title) || result.title,
        artist: artist || result.artist,
        album: cleanText(album.title || album.attributes?.title) || result.album,
        label: getLabel(track, album) || result.label || "",
        year: year || result.year,
        releaseDate: releaseDate || result.releaseDate || "",
        releaseEvidence: getReleaseEvidence(track, album),
        durationMs: getDurationMs(track) || result.durationMs,
        imageUrl: getImageUrl(track, album) || result.imageUrl || "",
        yearSource: year ? "tidal-detail" : result.yearSource
      };
    } catch {
      return result;
    }
  }

  async searchV2(track, query, options = {}) {
    const searchUrl = new URL(`${TIDAL_SEARCH_ROOT}/${encodeURIComponent(query)}/relationships/tracks`);
    searchUrl.searchParams.set("countryCode", this.countryCode);
    searchUrl.searchParams.set("include", "tracks,albums,artists");
    searchUrl.searchParams.set("limit", "5");

    const searchJson = await this.fetchTidalJson(searchUrl.toString());
    const candidate = chooseCandidate(searchJson, track, options);
    return candidate ? buildResult(candidate, searchJson, query) : null;
  }

  async searchLegacy(track, query, options = {}) {
    const searchUrl = new URL(TIDAL_LEGACY_SEARCH_URL);
    searchUrl.searchParams.set("query", query);
    searchUrl.searchParams.set("countryCode", this.countryCode);
    searchUrl.searchParams.set("limit", "10");

    const searchJson = await this.fetchTidalJson(searchUrl.toString());
    const candidate = chooseCandidate(searchJson, track, options);
    return candidate ? buildResult(candidate, searchJson, query) : null;
  }

  async fetchTidalJson(url, attempt = 0) {
    const token = await this.getAccessToken();
    const now = Date.now();
    if (this.nextRequestAt > now) await sleep(this.nextRequestAt - now);

    const response = await fetchWithTimeout(url, {
      headers: {
        accept: "application/vnd.api+json, application/json",
        authorization: `Bearer ${token}`,
        "user-agent": USER_AGENT
      }
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") || 2);
      if (attempt >= 2) throw new Error("TIDAL lookup failed: rate limited");
      this.nextRequestAt = Date.now() + Math.max(1, retryAfter) * 1000;
      await sleep(Math.max(1, retryAfter) * 1000);
      return this.fetchTidalJson(url, attempt + 1);
    }

    this.nextRequestAt = Date.now() + 275;
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`TIDAL lookup failed: HTTP ${response.status}`);
    return response.json();
  }

  async getAccessToken() {
    if (this.accessToken) return this.accessToken;

    const now = Date.now();
    if (this.token?.accessToken && this.token.expiresAtMs - now > 60_000) return this.token.accessToken;
    if (!this.clientId || !this.clientSecret) throw new Error("TIDAL credentials are missing.");

    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`, "utf8").toString("base64");
    const response = await fetchWithTimeout(TIDAL_TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: new URLSearchParams({ grant_type: "client_credentials" })
    });

    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.access_token) {
      throw new Error(`TIDAL token request failed: ${json?.error_description || json?.error || response.status}`);
    }

    this.token = {
      accessToken: cleanText(json.access_token),
      expiresAtMs: now + Math.max(60, Number(json.expires_in || 3600)) * 1000
    };

    return this.token.accessToken;
  }
}

module.exports = {
  TidalVerifier,
  createSearchQueries
};
