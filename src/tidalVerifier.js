"use strict";

const USER_AGENT = "RoonLocalAI/0.1.0";
const TIDAL_TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";
const TIDAL_SEARCH_ROOT = "https://openapi.tidal.com/v2/searchResults";
const TIDAL_TRACK_ROOT = "https://openapi.tidal.com/v2/tracks";
const TIDAL_LEGACY_SEARCH_URL = "https://api.tidal.com/v1/search/tracks";
const {
  CircuitBreaker,
  DEFAULT_TIDAL_CIRCUIT_COOLDOWN_MS,
  DEFAULT_TIDAL_CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_TIDAL_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  httpStatusError,
  positiveNumber
} = require("./tidalRequestGuard");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function artistNameLooksClose(left, right) {
  if (left === right) return true;
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) return true;
  const maxLength = Math.max(left.length, right.length);
  const minLength = Math.min(left.length, right.length);
  if (minLength < 6) return false;
  const maxDistance = maxLength >= 10 ? 2 : 1;
  if (Math.abs(left.length - right.length) > maxDistance) return false;
  if (left.slice(0, 3) !== right.slice(0, 3)) return false;
  return boundedEditDistance(left, right, maxDistance) <= maxDistance;
}

const GENERIC_VERSION_TOKENS = new Set([
  "mix",
  "remix",
  "edit",
  "version",
  "extended",
  "original",
  "radio",
  "club",
  "dub",
  "instrumental",
  "vip",
  "remaster",
  "remastered",
  "anniversary",
  "edition"
]);

function descriptorTokens(value) {
  const descriptors = [];
  for (const match of String(value || "").matchAll(/[\[(]([^\])]+)[\])]/g)) {
    descriptors.push(match[1]);
  }
  const text = normalizeMatchText(descriptors.join(" "));
  if (!text) return [];
  return Array.from(new Set(text
    .split(/\s+/)
    .filter((token) => token.length > 1 && !GENERIC_VERSION_TOKENS.has(token))));
}

function titleMatchScore(resultTitle = "", trackTitle = "", { strict = false } = {}) {
  const resultFull = normalizeMatchText(resultTitle);
  const trackFull = normalizeMatchText(trackTitle);
  const resultBase = normalizeMatchText(stripMixVersionSuffix(resultTitle));
  const trackBase = normalizeMatchText(stripMixVersionSuffix(trackTitle));
  const resultKeys = getTitleMatchKeys(resultTitle);
  const trackKeys = getTitleMatchKeys(trackTitle);
  if (!resultFull || !trackFull || !resultKeys.length || !trackKeys.length) return 0;

  let score = 0;
  if (resultFull === trackFull) score = 130;
  else if (resultBase && trackBase && resultBase === trackBase) score = 105;
  else if (!strict && titleKeysMatch(resultKeys, trackKeys)) score = 35;
  else return 0;

  const wantedDescriptors = descriptorTokens(trackTitle);
  const resultDescriptors = descriptorTokens(resultTitle);
  if (wantedDescriptors.length) {
    const matched = wantedDescriptors.filter((token) => resultDescriptors.includes(token) || resultFull.includes(token)).length;
    if (matched === wantedDescriptors.length) score += 15;
    else if (resultBase && trackBase && resultBase === trackBase) score -= 45;
    else score -= 30;
  } else if (resultDescriptors.length && resultBase && trackBase && resultBase === trackBase) {
    score -= 5;
  }

  return Math.max(0, score);
}

function artistMatchScore(item = {}, track = {}, searchJson = {}) {
  const trackArtists = getArtistLookupAliases(track.artist).map(normalizeMatchText).filter(Boolean);
  const resultArtists = getArtistLookupAliases(getArtistNames(item, searchJson).join(", ")).map(normalizeMatchText).filter(Boolean);
  if (!trackArtists.length || !resultArtists.length) return 0;
  return trackArtists.some((artist) => resultArtists.some((resultArtist) => artistNameLooksClose(artist, resultArtist))) ? 45 : 0;
}

function candidateMatchScore(item = {}, track = {}, searchJson = {}, options = {}) {
  const titleScore = titleMatchScore(item.title || item.attributes?.title, track.title, options);
  if (!titleScore) return 0;
  const artistScore = artistMatchScore(item, track, searchJson);
  if (!artistScore) return 0;
  return titleScore + artistScore;
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

function normalizeMediaTags(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  const tags = raw.flatMap((entry) => {
    if (!entry) return [];
    if (Array.isArray(entry)) return normalizeMediaTags(entry);
    if (typeof entry === "object") return [entry.name, entry.value, entry.label, entry.type].filter(Boolean);
    return String(entry).split(/[,|]+/);
  });

  return Array.from(new Set(tags
    .map((tag) => cleanText(tag).replace(/\s+/g, "_").toUpperCase())
    .filter(Boolean)));
}

function getMediaTags(item = {}) {
  return normalizeMediaTags([
    item.mediaTags,
    item.media_tags,
    item.audioModes,
    item.audio_modes,
    item.tags,
    item.attributes?.mediaTags,
    item.attributes?.media_tags,
    item.attributes?.audioModes,
    item.attributes?.audio_modes,
    item.attributes?.tags
  ]);
}

function getAudioQuality(item = {}) {
  return cleanText(
    item.audioQuality ||
    item.audio_quality ||
    item.quality ||
    item.attributes?.audioQuality ||
    item.attributes?.audio_quality ||
    item.attributes?.quality
  );
}

function firstNumber(values = []) {
  for (const value of values) {
    const number = Number(String(value ?? "").replace(/[^\d.]+/g, ""));
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function getSampleRateKhz(item = {}) {
  const value = firstNumber([
    item.sampleRateKhz,
    item.sample_rate_khz,
    item.sampleRate,
    item.sample_rate,
    item.audioSampleRate,
    item.audio_sample_rate,
    item.attributes?.sampleRateKhz,
    item.attributes?.sample_rate_khz,
    item.attributes?.sampleRate,
    item.attributes?.sample_rate,
    item.attributes?.audioSampleRate,
    item.attributes?.audio_sample_rate
  ]);
  if (!value) return null;
  return value > 1000 ? Math.round((value / 1000) * 10) / 10 : Math.round(value * 10) / 10;
}

function getBitDepth(item = {}) {
  return firstNumber([
    item.bitDepth,
    item.bit_depth,
    item.bitsPerSample,
    item.bits_per_sample,
    item.audioBitDepth,
    item.audio_bit_depth,
    item.attributes?.bitDepth,
    item.attributes?.bit_depth,
    item.attributes?.bitsPerSample,
    item.attributes?.bits_per_sample,
    item.attributes?.audioBitDepth,
    item.attributes?.audio_bit_depth
  ]);
}

function getChannelCount(item = {}) {
  return firstNumber([
    item.channels,
    item.channelCount,
    item.channel_count,
    item.audioChannels,
    item.audio_channels,
    item.attributes?.channels,
    item.attributes?.channelCount,
    item.attributes?.channel_count,
    item.attributes?.audioChannels,
    item.attributes?.audio_channels
  ]);
}

function codecFromMetadata(metadata = {}, tags = []) {
  const explicit = cleanText(
    metadata.codec ||
    metadata.audioCodec ||
    metadata.audio_codec ||
    metadata.format ||
    metadata.container ||
    metadata.attributes?.codec ||
    metadata.attributes?.audioCodec ||
    metadata.attributes?.audio_codec ||
    metadata.attributes?.format ||
    metadata.attributes?.container
  ).toUpperCase();
  if (explicit) return explicit.replace(/^AUDIO_/, "");
  if (tags.some((tag) => /(?:HIRES|HI_RES|LOSSLESS|MQA)/.test(tag))) return "FLAC";
  return "";
}

function qualityLabelFromTags(tags = [], audioQuality = "") {
  const tagSet = new Set(tags);
  if (tagSet.has("DOLBY_ATMOS")) return "Dolby Atmos";
  if (tagSet.has("SONY_360RA") || tagSet.has("SONY_360_REALITY_AUDIO")) return "360 Reality Audio";
  if (tagSet.has("HIRES_LOSSLESS") || tagSet.has("HI_RES_LOSSLESS") || tagSet.has("HI_RES")) return "HiRes Lossless";
  if (tagSet.has("MQA")) return "MQA";
  if (tagSet.has("LOSSLESS")) return "Lossless";

  const quality = cleanText(audioQuality).replace(/_/g, " ").toLowerCase();
  if (!quality) return "";
  if (/hi.?res/.test(quality) && /lossless/.test(quality)) return "HiRes Lossless";
  if (/lossless/.test(quality)) return "Lossless";
  if (/high/.test(quality)) return "High";
  if (/low/.test(quality)) return "Low";
  return quality.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatSampleRateKhz(value) {
  const sampleRate = Number(value || 0);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return "";
  return `${Number.isInteger(sampleRate) ? sampleRate : sampleRate.toFixed(1)}kHz`;
}

function trackSourceQualityFromMetadata(metadata = {}, options = {}) {
  const mediaTags = getMediaTags(metadata);
  const audioQuality = getAudioQuality(metadata);
  const sampleRateKhz = getSampleRateKhz(metadata);
  const bitDepth = getBitDepth(metadata);
  const channels = getChannelCount(metadata);
  const codec = codecFromMetadata(metadata, mediaTags);
  const source = cleanText(options.source || metadata.sourceLabel || metadata.provider || "TIDAL").toUpperCase();
  const exactParts = [
    formatSampleRateKhz(sampleRateKhz),
    bitDepth ? `${Math.round(bitDepth)}bit` : "",
    channels ? `${Math.round(channels)}ch` : ""
  ].filter(Boolean);
  const quality = qualityLabelFromTags(mediaTags, audioQuality);
  const displayParts = [source, codec].filter(Boolean);

  if (exactParts.length) displayParts.push(...exactParts);
  else if (quality) displayParts.push(quality);

  return {
    source,
    codec,
    quality,
    mediaTags,
    audioQuality,
    sampleRateKhz,
    bitDepth,
    channels,
    exact: exactParts.length > 0,
    display: displayParts.length > 1 ? displayParts.join(" ") : ""
  };
}

function isTidalTrackMatch(item = {}, track = {}, searchJson = {}, { strict = false } = {}) {
  return candidateMatchScore(item, track, searchJson, { strict }) > 0;
}

function chooseCandidateResult(searchJson, track = {}, options = {}) {
  return getItems(searchJson)
    .map((entry, index) => ({
      entry,
      index,
      score: candidateMatchScore(entry, track, searchJson, options)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0] || null;
}

function chooseCandidate(searchJson, track = {}, options = {}) {
  return chooseCandidateResult(searchJson, track, options)?.entry || null;
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
    mediaTags: getMediaTags(item),
    audioQuality: getAudioQuality(item),
    sampleRateKhz: getSampleRateKhz(item),
    bitDepth: getBitDepth(item),
    channels: getChannelCount(item),
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
    this.staticAccessTokenRejected = false;
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.clock = config.clock || (() => Date.now());
    this.timeoutMs = positiveNumber(config.timeoutMs, DEFAULT_TIDAL_FETCH_TIMEOUT_MS, { min: 500, max: 120_000 });
    this.circuitBreaker = config.circuitBreaker || new CircuitBreaker({
      label: "TIDAL",
      failureThreshold: config.failureThreshold || DEFAULT_TIDAL_CIRCUIT_FAILURE_THRESHOLD,
      cooldownMs: config.circuitCooldownMs || DEFAULT_TIDAL_CIRCUIT_COOLDOWN_MS,
      clock: this.clock
    });
    this.token = null;
    this.cache = new Map();
    this.nextRequestAt = 0;
  }

  isConfigured() {
    return Boolean(this.enabled && (this.accessToken || (this.clientId && this.clientSecret)));
  }

  status() {
    return {
      enabled: this.enabled,
      configured: this.isConfigured(),
      timeoutMs: this.timeoutMs,
      circuit: this.circuitBreaker.status()
    };
  }

  async fetchTidalResponse(url, options = {}, label = "TIDAL request") {
    this.circuitBreaker.assertCanRequest();

    let response;
    try {
      response = await fetchWithTimeout(url, options, {
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        label
      });
    } catch (error) {
      this.circuitBreaker.recordFailure(error);
      throw error;
    }

    if (response.status >= 500) {
      const error = httpStatusError(label, response.status);
      this.circuitBreaker.recordFailure(error);
      throw error;
    }
    if (response.ok || response.status === 404) {
      this.circuitBreaker.recordSuccess();
    }
    return response;
  }

  async verify(track, { strict = false } = {}) {
    if (!this.isConfigured()) return null;
    const cacheKey = `${strict ? "strict" : "loose"}:${normalizeMatchText(track.artist)}|${normalizeMatchText(track.title)}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    let lastError = null;
    let fallbackResult = null;
    const highConfidenceScore = strict ? 175 : 145;

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
        if (Number(result.matchScore || 0) >= highConfidenceScore) {
          const verified = await this.withPageYear(await this.withDetailYear(result));
          this.cache.set(cacheKey, verified);
          return verified;
        }
        if (!fallbackResult || Number(result.matchScore || 0) > Number(fallbackResult.matchScore || 0)) {
          fallbackResult = result;
        }
      }
    }

    if (fallbackResult) {
      const verified = await this.withPageYear(await this.withDetailYear(fallbackResult));
      this.cache.set(cacheKey, verified);
      return verified;
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
      mediaTags: [],
      audioQuality: "",
      sampleRateKhz: null,
      bitDepth: null,
      channels: null,
      source: "tidal"
    });

    const finalResult = result.title && result.artist ? result : null;
    this.cache.set(cacheKey, finalResult);
    return finalResult;
  }

  async withPageYear(result) {
    if ((result.year && result.releaseDate) || !result.tidalUrl) return result;

    try {
      const response = await this.fetchTidalResponse(result.tidalUrl, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": USER_AGENT
        }
      }, "TIDAL page lookup");
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
        mediaTags: getMediaTags(track).length ? getMediaTags(track) : (result.mediaTags || []),
        audioQuality: getAudioQuality(track) || result.audioQuality || "",
        sampleRateKhz: getSampleRateKhz(track) || result.sampleRateKhz || null,
        bitDepth: getBitDepth(track) || result.bitDepth || null,
        channels: getChannelCount(track) || result.channels || null,
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
    searchUrl.searchParams.set("limit", "20");

    const searchJson = await this.fetchTidalJson(searchUrl.toString());
    const candidate = chooseCandidateResult(searchJson, track, options);
    return candidate ? {
      ...buildResult(candidate.entry, searchJson, query),
      matchScore: candidate.score
    } : null;
  }

  async searchLegacy(track, query, options = {}) {
    const searchUrl = new URL(TIDAL_LEGACY_SEARCH_URL);
    searchUrl.searchParams.set("query", query);
    searchUrl.searchParams.set("countryCode", this.countryCode);
    searchUrl.searchParams.set("limit", "20");

    const searchJson = await this.fetchTidalJson(searchUrl.toString());
    const candidate = chooseCandidateResult(searchJson, track, options);
    return candidate ? {
      ...buildResult(candidate.entry, searchJson, query),
      matchScore: candidate.score
    } : null;
  }

  async fetchTidalJson(url, attempt = 0) {
    const token = await this.getAccessToken();
    const now = this.clock();
    if (this.nextRequestAt > now) await sleep(this.nextRequestAt - now);

    const response = await this.fetchTidalResponse(url, {
      headers: {
        accept: "application/vnd.api+json, application/json",
        authorization: `Bearer ${token}`,
        "user-agent": USER_AGENT
      }
    }, "TIDAL API lookup");

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") || 2);
      const rateLimitError = httpStatusError("TIDAL API lookup", response.status);
      if (attempt >= 2) this.circuitBreaker.recordFailure(rateLimitError);
      if (attempt >= 2) throw new Error("TIDAL lookup failed: rate limited");
      this.nextRequestAt = this.clock() + Math.max(1, retryAfter) * 1000;
      await sleep(Math.max(1, retryAfter) * 1000);
      return this.fetchTidalJson(url, attempt + 1);
    }

    this.nextRequestAt = this.clock() + 275;
    if (response.status === 404) return null;
    if (response.status === 401) {
      if (attempt < 1 && this.invalidateRejectedAccessToken(token)) {
        return this.fetchTidalJson(url, attempt + 1);
      }
      const error = new Error(this.accessToken
        ? "Configured TIDAL_ACCESS_TOKEN was rejected by TIDAL. Remove it or configure TIDAL_CLIENT_ID/TIDAL_CLIENT_SECRET so Rabbit Hole can fetch a fresh catalog token."
        : "TIDAL catalog token was rejected. Check TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET.");
      error.status = 401;
      error.source = "tidal";
      throw error;
    }
    if (!response.ok) throw httpStatusError("TIDAL API lookup", response.status);
    return response.json();
  }

  invalidateRejectedAccessToken(token = "") {
    const rejected = cleanText(token);
    if (!rejected) return false;
    if (this.token?.accessToken && rejected === this.token.accessToken) {
      this.token = null;
      return Boolean(this.clientId && this.clientSecret);
    }
    if (this.accessToken && rejected === this.accessToken) {
      this.staticAccessTokenRejected = true;
      return Boolean(this.clientId && this.clientSecret);
    }
    return false;
  }

  async getAccessToken() {
    if (this.accessToken && !this.staticAccessTokenRejected) return this.accessToken;

    const now = this.clock();
    if (this.token?.accessToken && this.token.expiresAtMs - now > 60_000) return this.token.accessToken;
    if (!this.clientId || !this.clientSecret) {
      if (this.accessToken && this.staticAccessTokenRejected) {
        throw new Error("Configured TIDAL_ACCESS_TOKEN was rejected by TIDAL. Remove it or configure TIDAL_CLIENT_ID/TIDAL_CLIENT_SECRET so Rabbit Hole can fetch a fresh catalog token.");
      }
      throw new Error("TIDAL credentials are missing.");
    }

    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`, "utf8").toString("base64");
    const response = await this.fetchTidalResponse(TIDAL_TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: new URLSearchParams({ grant_type: "client_credentials" })
    }, "TIDAL token request");

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
  createSearchQueries,
  trackSourceQualityFromMetadata
};
