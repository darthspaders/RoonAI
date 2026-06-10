const EventEmitter = require("events");

const DEFAULT_MIN_LOOKUP_INTERVAL_MS = 1500;
const DEFAULT_CACHE_MAX = 200;
const USER_AGENT = "RoonPresence/0.1.0 (https://github.com/darthspaders/RoonPresence)";
const TIDAL_TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";
const TIDAL_SEARCH_ROOT = "https://openapi.tidal.com/v2/searchResults";
const TIDAL_TRACK_ROOT = "https://openapi.tidal.com/v2/tracks";
const TIDAL_ALBUM_ROOT = "https://openapi.tidal.com/v2/albums";
const TIDAL_LEGACY_SEARCH_URL = "https://api.tidal.com/v1/search/tracks";
const TIDAL_WEB_SEARCH_BASE_URL = "https://tidal.com/search?q=";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function describeError(error) {
  if (error instanceof Error) return error.message || error.name || "unknown error";
  if (typeof error === "string") return error || "unknown error";
  try {
    return JSON.stringify(error) || String(error) || "unknown error";
  } catch {
    return String(error) || "unknown error";
  }
}

function normalizeKeyPart(value) {
  return cleanText(value).toLowerCase();
}

function isStationText(value) {
  return /\b(?:di\.?fm|radio|house|trance|progressive|channel|station|live|insomniac|mpact|impact|bangers|psy)\b|\|/i.test(cleanText(value));
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function cleanStationName(value) {
  const text = cleanText(value);
  if (!isStationText(text)) return "";

  for (const separator of [" - ", " \u2013 ", " \u2014 "]) {
    if (!text.includes(separator)) continue;
    const [left, ...rest] = text.split(separator);
    const right = rest.join(separator);
    if (text.includes("|") || !isStationText(right)) return cleanText(left);
  }

  return text;
}

function getRadioStationName(metadata = {}) {
  const candidates = [metadata.radioStationName, metadata.originalTitle, metadata.title, metadata.album];
  return firstText(...candidates.map((value) => cleanStationName(value)));
}

function stripRadioNoise(value) {
  return cleanText(value)
    .replace(/\s+\|\s+.*$/g, "")
    .replace(/\s+on\s+DI\.?FM.*$/i, "")
    .replace(/\s+-\s+DI\.?FM.*$/i, "")
    .replace(/\s+\([^)]*radio[^)]*\)\s*$/i, "")
    .trim();
}

function splitArtistTitle(value) {
  const text = stripRadioNoise(value);
  const separators = [" - ", " \u2013 ", " \u2014 "];

  for (const separator of separators) {
    if (!text.includes(separator)) continue;
    const [left, ...rest] = text.split(separator);
    const right = rest.join(separator);
    const a = cleanText(left);
    const b = cleanText(right);
    if (!a || !b || isStationText(b)) continue;
    if (isStationText(a)) {
      const nested = splitArtistTitle(b);
      return nested || { artist: "", title: b };
    }
    return { artist: a, title: b };
  }

  return null;
}

function parseRadioTrack(metadata = {}) {
  const title = stripRadioNoise(metadata.title);
  const artist = stripRadioNoise(metadata.artist);
  const album = stripRadioNoise(metadata.album);
  const originalTitle = stripRadioNoise(metadata.originalTitle);
  const originalArtist = stripRadioNoise(metadata.originalArtist);
  const originalAlbum = stripRadioNoise(metadata.originalAlbum);
  const activityDetails = stripRadioNoise(metadata.activityDetails);
  const activityState = stripRadioNoise(metadata.activityState);
  const titleLooksStation = isStationText(title);
  const artistLooksStation = isStationText(artist);
  const albumLooksStation = isStationText(album);

  const richCandidates = [artist, originalArtist, activityState, title, originalTitle, activityDetails, album, originalAlbum];
  for (const value of richCandidates) {
    const parsed = splitArtistTitle(value);
    if (parsed?.artist && parsed?.title) return parsed;
  }

  for (const value of [title, originalTitle, activityDetails]) {
    const parsed = splitArtistTitle(value);
    if (!parsed?.title) continue;
    if (parsed.artist) return parsed;
    if (artist && !artistLooksStation) return { artist, title: parsed.title };
    return { artist: "", title: parsed.title };
  }

  if (title && artist && titleLooksStation && !artistLooksStation) {
    for (const candidate of [album, originalAlbum, activityState, originalArtist]) {
      const cleanCandidate = stripRadioNoise(candidate);
      if (cleanCandidate && !isStationText(cleanCandidate) && cleanCandidate !== artist) {
        return { artist: cleanCandidate, title: artist };
      }
    }
    return { artist: "", title: artist };
  }

  if (title && artist && !titleLooksStation && !artistLooksStation) {
    return { title, artist };
  }

  if (title && artist && !artistLooksStation) {
    return { title, artist };
  }

  if (title && !titleLooksStation && album && !albumLooksStation) {
    return { artist: album, title };
  }

  return null;
}
function makeLookupKey(track) {
  return `${normalizeKeyPart(track.artist)}|${normalizeKeyPart(track.title)}`;
}

async function defaultFetchJson(url, { headers = {} } = {}) {
  if (typeof fetch !== "function") throw new Error("global fetch is not available");

  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
      ...headers
    }
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function chooseRelease(recording) {
  const releases = Array.isArray(recording?.releases) ? recording.releases : [];
  return releases.find((release) => release?.id && release?.["release-group"]?.id) ||
    releases.find((release) => release?.id) ||
    null;
}

function chooseCoverImage(coverJson) {
  const images = Array.isArray(coverJson?.images) ? coverJson.images : [];
  const front = images.find((image) => image?.front) || images[0];
  if (!front) return "";

  return cleanText(
    front.thumbnails?.["500"] ||
      front.thumbnails?.large ||
      front.thumbnails?.["250"] ||
      front.thumbnails?.small ||
      front.image
  );
}
function isUsableDiscogsImage(value) {
  const url = cleanText(value);
  return !!url && !/spacer\.gif/i.test(url);
}

function normalizeDiscogsMatchText(value) {
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
    normalizeDiscogsMatchText(value),
    normalizeDiscogsMatchText(stripMixVersionSuffix(value))
  ].filter(Boolean)));
}

function titleKeysMatch(leftKeys, rightKeys) {
  return leftKeys.some((left) => rightKeys.some((right) => left === right || left.includes(right) || right.includes(left)));
}

function isDiscogsTrackMatch(result, track = {}) {
  const resultTitle = normalizeDiscogsMatchText(result?.title);
  const trackTitle = normalizeDiscogsMatchText(track.title);
  const trackArtists = getArtistLookupAliases(track.artist).map(normalizeDiscogsMatchText).filter(Boolean);

  if (!resultTitle) return false;
  if (trackTitle && !resultTitle.includes(trackTitle)) return false;
  if (trackArtists.length && !trackArtists.some((artist) => resultTitle.includes(artist))) return false;
  return true;
}

function chooseDiscogsResult(searchJson, track = {}) {
  const results = Array.isArray(searchJson?.results) ? searchJson.results : [];
  const usableResults = results.filter((entry) => isUsableDiscogsImage(entry?.cover_image));
  const result = usableResults.find((entry) => isDiscogsTrackMatch(entry, track)) ||
    (!track.title && !track.artist ? usableResults[0] : null);
  if (!result) return null;

  return {
    title: cleanText(result.title),
    coverImage: cleanText(result.cover_image)
  };
}
function toDurationMs(value, unit = "ms") {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return unit === "seconds" ? Math.round(duration * 1000) : Math.round(duration);
}
function tidalCoverUrlFromUuid(uuid, size = 640) {
  const cleanUuid = cleanText(uuid);
  if (!cleanUuid) return "";
  if (/^https?:\/\//i.test(cleanUuid)) return cleanUuid;
  return "https://resources.tidal.com/images/" + cleanUuid.replace(/-/g, "/") + "/" + size + "x" + size + ".jpg";
}

function decodeWebText(value) {
  return String(value || "")
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/");
}

function firstTidalImageLink(value) {
  if (!value) return "";
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstTidalImageLink(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    return cleanText(value.href || value.url || value.src || value.image || value.imageUrl || value.urlTemplate);
  }
  return "";
}

function firstImageUrl(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const text = cleanText(value);
    if (/^https?:\/\/.+\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i.test(text)) return text;
    if (/^https?:\/\/(?:resources\.tidal\.com|images\.tidal\.com|resources\.wimpmusic\.com)\//i.test(text)) return text;
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstImageUrl(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of ["href", "url", "src", "image", "imageUrl", "urlTemplate"]) {
      const found = firstImageUrl(value[key]);
      if (found) return found;
    }
    for (const item of Object.values(value)) {
      const found = firstImageUrl(item);
      if (found) return found;
    }
  }
  return "";
}

function extractTidalWebArtwork(html) {
  const text = decodeWebText(html);
  const direct = text.match(/https?:\/\/resources\.tidal\.com\/images\/[^"'<>\s]+?\.(?:jpg|jpeg|png|webp)/i);
  if (direct) return cleanText(direct[0]);

  const cover = text.match(/(?:imageCover|cover)["'\s:]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return cover ? tidalCoverUrlFromUuid(cover[1]) : "";
}

function extractTidalWebTrackUrl(html) {
  const text = decodeWebText(html);
  const absolute = text.match(/https?:\/\/(?:listen\.)?tidal\.com\/(?:browse\/)?track\/[0-9]+/i);
  if (absolute) return cleanText(absolute[0]);

  const relative = text.match(/(?:href|url)["\'\s:=]+(\/(?:browse\/)?track\/[0-9]+)/i);
  return relative ? "https://tidal.com" + relative[1] : "";
}

function getTidalIncluded(searchJson, type) {
  const included = Array.isArray(searchJson?.included) ? searchJson.included : [];
  return included.filter((entry) => cleanText(entry?.type) === type);
}

function getTidalRelationshipData(item, name) {
  const data = item?.relationships?.[name]?.data;
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

function findTidalIncluded(searchJson, ref, type) {
  const wantedType = cleanText(ref?.type || type);
  const wantedId = cleanText(ref?.id);
  if (!wantedId) return null;
  return getTidalIncluded(searchJson, wantedType).find((entry) => cleanText(entry?.id) === wantedId) || null;
}

function getTidalItems(searchJson) {
  if (Array.isArray(searchJson?.items)) return searchJson.items;
  if (Array.isArray(searchJson?.tracks?.items)) return searchJson.tracks.items;

  const data = Array.isArray(searchJson?.data) ? searchJson.data : (searchJson?.data ? [searchJson.data] : []);
  const dataTracks = data.filter((entry) => cleanText(entry?.type) === "tracks" || entry?.attributes?.title || entry?.title);
  if (dataTracks.length) {
    return dataTracks.map((entry) => findTidalIncluded(searchJson, entry, "tracks") || entry);
  }

  return getTidalIncluded(searchJson, "tracks");
}

function getTidalArtistNames(item = {}, searchJson = {}) {
  const artists = Array.isArray(item.artists) ? item.artists : [];
  const flatNames = artists.map((artist) => cleanText(artist?.name)).filter(Boolean);
  if (flatNames.length) return flatNames;

  const relationshipNames = getTidalRelationshipData(item, "artists")
    .map((ref) => findTidalIncluded(searchJson, ref, "artists"))
    .map((artist) => cleanText(artist?.attributes?.name || artist?.name))
    .filter(Boolean);
  if (relationshipNames.length) return relationshipNames;

  return [cleanText(item.artist?.name || item.attributes?.artistName)].filter(Boolean);
}

function getTidalAlbum(item = {}, searchJson = {}) {
  const flatAlbum = item.album || {};
  if (flatAlbum.cover || flatAlbum.title || flatAlbum.attributes?.cover || flatAlbum.attributes?.imageCover) return flatAlbum;

  const ref = getTidalRelationshipData(item, "albums")[0] || getTidalRelationshipData(item, "album")[0];
  return findTidalIncluded(searchJson, ref, "albums") || {};
}

function getTidalAlbumRefs(item = {}) {
  return [
    ...getTidalRelationshipData(item, "albums"),
    ...getTidalRelationshipData(item, "album")
  ].filter((ref) => cleanText(ref?.id));
}

function getTidalCoverArtRefs(item = {}) {
  return [
    ...getTidalRelationshipData(item, "coverArt"),
    ...getTidalRelationshipData(item, "cover_art"),
    ...getTidalRelationshipData(item, "artwork")
  ].filter((ref) => cleanText(ref?.id));
}

function getTidalExternalLink(item = {}) {
  const links = Array.isArray(item.attributes?.externalLinks) ? item.attributes.externalLinks : [];
  return cleanText(links.find((link) => link?.meta?.type === "TIDAL_SHARING")?.href || links[0]?.href);
}

function normalizeTidalTrackUrl(value) {
  const url = cleanText(value);
  const trackMatch = url.match(/^https?:\/\/(?:www\.)?(?:listen\.)?tidal\.com\/(?:browse\/)?track\/(\d+)/i);
  if (trackMatch) return `https://tidal.com/browse/track/${trackMatch[1]}`;
  return url;
}

function getTidalTrackUrl(item = {}) {
  const directUrl = cleanText(item.url || item.shareUrl || item.attributes?.url || item.attributes?.shareUrl);
  if (/^https?:\/\//i.test(directUrl)) return normalizeTidalTrackUrl(directUrl);
  const externalLink = getTidalExternalLink(item);
  if (externalLink) return normalizeTidalTrackUrl(externalLink);
  const id = cleanText(item.id);
  return /^\d+$/.test(id) ? `https://tidal.com/browse/track/${id}` : "";
}

function isTidalTrackMatch(item = {}, track = {}, searchJson = {}) {
  const resultTitleKeys = getTitleMatchKeys(item.title || item.attributes?.title);
  const trackTitleKeys = getTitleMatchKeys(track.title);
  const trackArtists = getArtistLookupAliases(track.artist).map(normalizeDiscogsMatchText).filter(Boolean);
  const resultArtist = normalizeDiscogsMatchText(getTidalArtistNames(item, searchJson).join(" "));

  if (!resultTitleKeys.length || !trackTitleKeys.length) return false;
  if (!titleKeysMatch(resultTitleKeys, trackTitleKeys)) return false;
  if (trackArtists.length && resultArtist && !trackArtists.some((artist) => resultArtist.includes(artist) || artist.includes(resultArtist))) return false;
  return true;
}

function getTidalCoverImage(...values) {
  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string") {
      const direct = cleanText(value);
      if (/^https?:\/\//i.test(direct)) return direct;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(direct)) return tidalCoverUrlFromUuid(direct);
      continue;
    }

    const linked = firstTidalImageLink(value) || extractTidalWebArtwork(JSON.stringify(value || ""));
    if (linked) return getTidalCoverImage(linked);
  }
  return "";
}

function getTidalCoverArtUrl(resource = {}) {
  const directUrl = firstImageUrl(resource);
  if (directUrl) return directUrl;

  const attributes = resource.attributes || resource;
  const linked = firstImageUrl([
    attributes.files,
    attributes.media,
    attributes.images,
    attributes.imageLinks,
    attributes.sources,
    attributes.urls,
    attributes.url,
    attributes.href
  ]);
  if (linked) return linked;

  return getTidalCoverImage(
    resource.cover,
    resource.imageCover,
    attributes.cover,
    attributes.imageCover,
    resource.id,
    attributes.id
  );
}

function hasTidalCoverCandidate(item = {}, searchJson = {}) {
  const album = getTidalAlbum(item, searchJson);
  return !!getTidalCoverImage(
    album.cover,
    album.attributes?.cover,
    album.attributes?.imageCover,
    album.attributes?.imageLinks,
    album.attributes?.images,
    item.cover,
    item.attributes?.cover,
    item.attributes?.imageCover,
    item.attributes?.imageLinks,
    item.attributes?.images
  );
}

function isTidalTitleMatch(item = {}, track = {}) {
  const resultTitleKeys = getTitleMatchKeys(item.title || item.attributes?.title);
  const trackTitleKeys = getTitleMatchKeys(track.title);
  return !!resultTitleKeys.length && !!trackTitleKeys.length && titleKeysMatch(resultTitleKeys, trackTitleKeys);
}

function chooseTidalCandidate(searchJson, track = {}) {
  const items = getTidalItems(searchJson);
  return items.find((entry) => isTidalTrackMatch(entry, track, searchJson)) ||
    items.find((entry) => isTidalTitleMatch(entry, track) && hasTidalCoverCandidate(entry, searchJson)) ||
    null;
}

function buildTidalTrackResult(result, searchJson) {
  if (!result) return null;

  const album = getTidalAlbum(result, searchJson);
  const coverImage = getTidalCoverImage(
    album.cover,
    album.attributes?.cover,
    album.attributes?.imageCover,
    album.attributes?.imageLinks,
    album.attributes?.images,
    result.cover,
    result.attributes?.cover,
    result.attributes?.imageCover,
    result.attributes?.imageLinks,
    result.attributes?.images
  );
  if (!coverImage) return null;

  return {
    title: cleanText(result.title || result.attributes?.title),
    album: cleanText(album.title || album.attributes?.title),
    coverImage,
    durationMs: toDurationMs(result.duration || result.attributes?.duration, "seconds"),
    tidalUrl: getTidalTrackUrl(result)
  };
}

function chooseTidalTrack(searchJson, track = {}) {
  return buildTidalTrackResult(chooseTidalCandidate(searchJson, track), searchJson);
}

function getSpotifyItems(searchJson) {
  return Array.isArray(searchJson?.tracks?.items) ? searchJson.tracks.items : [];
}

function getSpotifyArtistNames(item = {}) {
  return (Array.isArray(item.artists) ? item.artists : [])
    .map((artist) => cleanText(artist?.name))
    .filter(Boolean);
}

function chooseSpotifyTrack(searchJson, track = {}) {
  const trackTitleKeys = getTitleMatchKeys(track.title);
  const trackArtist = normalizeDiscogsMatchText(track.artist);

  for (const item of getSpotifyItems(searchJson)) {
    const resultTitleKeys = getTitleMatchKeys(item?.name);
    const resultArtist = normalizeDiscogsMatchText(getSpotifyArtistNames(item).join(" "));
    if (!resultTitleKeys.length || !trackTitleKeys.length) continue;
    if (!titleKeysMatch(resultTitleKeys, trackTitleKeys)) continue;
    if (trackArtist && resultArtist && !resultArtist.includes(trackArtist) && !trackArtist.includes(resultArtist)) continue;

    const images = Array.isArray(item?.album?.images) ? item.album.images : [];
    const image = images.find((entry) => cleanText(entry?.url)) || null;
    if (!image) continue;

    return {
      title: cleanText(item.name),
      album: cleanText(item.album?.name),
      coverImage: cleanText(image.url),
      durationMs: toDurationMs(item.duration_ms),
      spotifyUrl: cleanText(item.external_urls?.spotify)
    };
  }

  return null;
}


class RadioMetadataResolver extends EventEmitter {
  constructor({
    enabled = true,
    cacheMax = DEFAULT_CACHE_MAX,
    minLookupIntervalMs = DEFAULT_MIN_LOOKUP_INTERVAL_MS,
    logger,
    spotifyArtworkEnabled = false,
    spotifyMarket = "US",
    spotifyClientId = "",
    spotifyClientSecret = "",
    tidalArtworkEnabled = true,
    tidalCountryCode = "US",
    tidalAccessToken = "",
    tidalClientId = "",
    tidalClientSecret = "",
    discogsEnabled = true,
    discogsToken = "",
    albumArtProvider,
    fetchJson = defaultFetchJson,
    fetchImpl = globalThis.fetch,
    clock = () => Date.now()
  } = {}) {
    super();
    this.enabled = !!enabled;
    this.cacheMax = Number(cacheMax) || DEFAULT_CACHE_MAX;
    this.minLookupIntervalMs = Number(minLookupIntervalMs) || DEFAULT_MIN_LOOKUP_INTERVAL_MS;
    this.logger = logger;
    this.spotifyArtworkEnabled = !!spotifyArtworkEnabled;
    this.spotifyMarket = cleanText(spotifyMarket || "US") || "US";
    this.spotifyClientId = cleanText(spotifyClientId);
    this.spotifyClientSecret = cleanText(spotifyClientSecret);
    this.spotifyToken = null;
    this.tidalArtworkEnabled = !!tidalArtworkEnabled;
    this.tidalCountryCode = cleanText(tidalCountryCode || "US") || "US";
    this.tidalAccessToken = cleanText(tidalAccessToken);
    this.tidalClientId = cleanText(tidalClientId);
    this.tidalClientSecret = cleanText(tidalClientSecret);
    this.tidalToken = null;
    this.discogsEnabled = !!discogsEnabled;
    this.discogsToken = cleanText(discogsToken);
    this.albumArtProvider = albumArtProvider;
    this.fetchJson = fetchJson;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.cache = new Map();
    this.pending = new Set();
    this.queue = [];
    this.inFlight = false;
    this.lastLookupAt = 0;
    this.timer = null;
  }

  apply(presence) {
    if (!this.enabled || presence?.timestampMode !== "RADIO") return false;

    const stationName = getRadioStationName(presence.metadata);
    if (stationName) presence.metadata.radioStationName = stationName;

    const track = parseRadioTrack({
      ...presence.metadata,
      activityDetails: presence.activity?.details,
      activityState: presence.activity?.state
    });
    if (!track) return false;

    const key = makeLookupKey(track);
    presence.metadata.radioTrackKey = key;
    presence.metadata.radioArtworkResolved = false;
    this.applyParsedTrack(presence, track);

    const cached = this.cache.get(key);
    if (cached?.status === "found") {
      this.applyResolvedMetadata(presence, cached.value);
      return true;
    }
    if (cached?.status === "missing") return false;

    this.enqueue(key, track);
    return false;
  }

  applyParsedTrack(presence, track) {
    if (track.title) presence.metadata.title = track.title;
    presence.metadata.artist = track.artist || "";

    if (presence.metadata.signalPath || !presence.activity) return;

    if (track.title) {
      presence.activity.details = (track.artist ? track.artist + " - " + track.title : track.title).slice(0, 128);
    }
    presence.activity.state = (presence.metadata.radioStationName || track.artist || "").slice(0, 128);
  }

  applyResolvedMetadata(presence, value) {
    if (!value?.albumArtUrl) return;

    presence.metadata.albumArtUrl = value.albumArtUrl;
    presence.metadata.albumArtKey = `radio:${value.key}`;
    presence.metadata.radioArtworkResolved = true;
    if (value.album) presence.metadata.album = value.album;
    if (value.tidalUrl) presence.metadata.tidalUrl = value.tidalUrl;
    if (value.spotifyUrl) presence.metadata.spotifyUrl = value.spotifyUrl;
    if (Number.isFinite(value.durationMs) && value.durationMs > 0) {
      presence.metadata.trackDurationMs = value.durationMs;
    }
  }

  enqueue(key, track) {
    if (this.pending.has(key)) return;

    this.pending.add(key);
    this.queue.push({ key, track });
    this.schedule();
  }

  schedule() {
    if (this.timer || this.inFlight) return;

    const waitMs = Math.max(0, this.minLookupIntervalMs - (this.clock() - this.lastLookupAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.processNext();
    }, waitMs);
  }

  async processNext() {
    if (this.inFlight || !this.queue.length) return;

    const item = this.queue.shift();
    this.inFlight = true;
    try {
      const value = await this.lookup(item.track, item.key);
      this.remember(item.key, value ? { status: "found", value } : { status: "missing" });
      if (value) {
        const label = item.track.artist ? `${item.track.artist} - ${item.track.title}` : item.track.title;
        this.logger?.info?.(`Resolved radio metadata: ${label}`);
        this.emit("metadataResolved", value);
      }
    } catch (error) {
      this.logger?.debug?.("Radio metadata lookup failed", { error: describeError(error) });
      this.remember(item.key, { status: "missing" });
    } finally {
      this.pending.delete(item.key);
      this.lastLookupAt = this.clock();
      this.inFlight = false;
      if (this.queue.length) this.schedule();
    }
  }

  async lookup(track, key) {
    const tidal = await this.lookupTidal(track, key);
    if (tidal) return tidal;

    const spotify = await this.lookupSpotify(track, key);
    if (spotify) return spotify;

    const discogs = await this.lookupDiscogs(track, key);
    if (discogs) return discogs;

    const recordings = await this.searchRecordings(track);

    for (const recording of recordings) {
      const release = chooseRelease(recording);
      if (!release) continue;

      const groupId = release["release-group"]?.id;
      const coverUrl = groupId
        ? `https://coverartarchive.org/release-group/${groupId}`
        : `https://coverartarchive.org/release/${release.id}`;
      const coverJson = await this.fetchJson(coverUrl);
      const albumArtUrl = chooseCoverImage(coverJson);
      if (!albumArtUrl) continue;
      const preparedAlbumArtUrl = await this.prepareAlbumArtUrl(albumArtUrl, key);
      if (!preparedAlbumArtUrl) continue;

      return {
        key,
        title: track.title,
        artist: track.artist,
        album: cleanText(release.title || recording.title),
        albumArtUrl: preparedAlbumArtUrl,
        durationMs: toDurationMs(recording.length)
      };
    }

    return null;
  }

  async lookupSpotify(track, key) {
    if (!this.spotifyArtworkEnabled) return null;

    try {
      return await this.searchSpotify(track, key);
    } catch (error) {
      this.logger?.warn?.("Spotify artwork lookup failed", { error: describeError(error) });
      return null;
    }
  }

  async searchSpotify(track, key) {
    if (!this.spotifyClientId || !this.spotifyClientSecret) return null;

    for (const query of this.createSearchQueries(track)) {
      const searchUrl = new URL(SPOTIFY_SEARCH_URL);
      searchUrl.searchParams.set("q", query);
      searchUrl.searchParams.set("type", "track");
      searchUrl.searchParams.set("market", this.spotifyMarket);
      searchUrl.searchParams.set("limit", "5");

      const searchJson = await this.fetchSpotifyJson(searchUrl.toString());
      const result = chooseSpotifyTrack(searchJson, track);
      if (!result) continue;

      const albumArtUrl = await this.prepareAlbumArtUrl(result.coverImage, key);
      if (!albumArtUrl) continue;

      this.logger?.info?.("Resolved Spotify artwork: " + (track.artist ? track.artist + " - " : "") + track.title);
      return {
        key,
        title: track.title,
        artist: track.artist,
        album: cleanText(result.album || result.title),
        albumArtUrl,
        durationMs: result.durationMs,
        spotifyUrl: result.spotifyUrl,
        source: "spotify"
      };
    }

    this.logger?.info?.("Spotify artwork not found; trying fallback sources: " + (track.artist ? track.artist + " - " : "") + track.title);
    return null;
  }

  createSearchQueries(track) {
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

  async fetchSpotifyJson(url) {
    const accessToken = await this.getSpotifyAccessToken();
    if (!accessToken) throw new Error("Spotify credentials missing: set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET, or disable SPOTIFY_ARTWORK_LOOKUP");
    return this.fetchJson(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`
      }
    });
  }

  async getSpotifyAccessToken() {
    if (!this.spotifyClientId || !this.spotifyClientSecret) return "";
    const now = this.clock();
    if (this.spotifyToken?.accessToken && this.spotifyToken.expiresAtMs - now > 60_000) {
      return this.spotifyToken.accessToken;
    }
    if (typeof this.fetchImpl !== "function") throw new Error("fetch is not available");

    const body = new URLSearchParams({ grant_type: "client_credentials" });
    const auth = Buffer.from(`${this.spotifyClientId}:${this.spotifyClientSecret}`, "utf8").toString("base64");
    const response = await this.fetchImpl(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body
    });

    let json;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok || !json?.access_token) {
      const message = json?.error_description || json?.error || `HTTP ${response.status}`;
      throw new Error(`Spotify token request failed: ${message}`);
    }

    const expiresInMs = Math.max(60, Number(json.expires_in || 3600)) * 1000;
    this.spotifyToken = {
      accessToken: cleanText(json.access_token),
      expiresAtMs: now + expiresInMs
    };
    this.logger?.info?.("Fetched Spotify access token with client credentials");
    return this.spotifyToken.accessToken;
  }

  async lookupTidal(track, key) {
    if (!this.tidalArtworkEnabled) return null;

    try {
      return await this.searchTidal(track, key);
    } catch (error) {
      this.logger?.warn?.("TIDAL artwork lookup failed", { error: describeError(error) });
      return null;
    }
  }

  async searchTidal(track, key) {
    const webResult = await this.searchTidalWeb(track, key);
    if (webResult) return webResult;
    this.logger?.info?.("TIDAL web artwork not found; trying TIDAL API: " + (track.artist ? track.artist + " - " : "") + track.title);

    for (const query of this.createSearchQueries(track)) {
      const searchUrl = new URL(`${TIDAL_SEARCH_ROOT}/${encodeURIComponent(query)}/relationships/tracks`);
      searchUrl.searchParams.set("countryCode", this.tidalCountryCode);
      searchUrl.searchParams.set("include", "tracks,albums,artists");
      searchUrl.searchParams.set("limit", "5");

      const searchJson = await this.fetchTidalSearchJson(searchUrl.toString());
      const candidate = chooseTidalCandidate(searchJson, track);
      if (!candidate) continue;

      let result = buildTidalTrackResult(candidate, searchJson);
      if (!result) {
        result = await this.lookupTidalTrackDetails(candidate, track);
      }
      if (!result) continue;

      const albumArtUrl = await this.prepareAlbumArtUrl(result.coverImage, key);
      if (!albumArtUrl) continue;

      this.logger?.info?.("Resolved TIDAL artwork: " + (track.artist ? track.artist + " - " : "") + track.title);
      return {
        key,
        title: track.title,
        artist: track.artist,
        album: cleanText(result.album || result.title),
        albumArtUrl,
        durationMs: result.durationMs,
        tidalUrl: result.tidalUrl,
        source: "tidal"
      };
    }

    const legacyResult = await this.searchTidalLegacy(track, key);
    if (legacyResult) return legacyResult;

    this.logger?.info?.("TIDAL artwork not found; trying non-TIDAL fallback sources: " + (track.artist ? track.artist + " - " : "") + track.title);
    return null;
  }

  async searchTidalLegacy(track, key) {
    for (const query of this.createSearchQueries(track)) {
      const searchUrl = new URL(TIDAL_LEGACY_SEARCH_URL);
      searchUrl.searchParams.set("query", query);
      searchUrl.searchParams.set("countryCode", this.tidalCountryCode);
      searchUrl.searchParams.set("limit", "10");

      const searchJson = await this.fetchTidalSearchJson(searchUrl.toString());
      const result = chooseTidalTrack(searchJson, track);
      if (!result) continue;

      const albumArtUrl = await this.prepareAlbumArtUrl(result.coverImage, key);
      if (!albumArtUrl) continue;

      this.logger?.info?.("Resolved TIDAL v1 artwork: " + (track.artist ? track.artist + " - " : "") + track.title);
      return {
        key,
        title: track.title,
        artist: track.artist,
        album: cleanText(result.album || result.title),
        albumArtUrl,
        durationMs: result.durationMs,
        tidalUrl: result.tidalUrl,
        source: "tidal-v1"
      };
    }

    return null;
  }

  async searchTidalWeb(track, key) {
    if (typeof this.fetchImpl !== "function") return null;

    for (const query of this.createSearchQueries(track)) {
      const searchUrl = this.createTidalWebSearchUrl(query);
      let html = "";
      try {
        html = await this.fetchText(searchUrl, {
          headers: {
            accept: "text/html,application/xhtml+xml",
            "user-agent": USER_AGENT
          }
        });
      } catch (error) {
        this.logger?.debug?.("TIDAL web artwork lookup failed", { error: describeError(error) });
        continue;
      }

      const coverImage = extractTidalWebArtwork(html);
      if (!coverImage) continue;

      const albumArtUrl = await this.prepareAlbumArtUrl(coverImage, key);
      if (!albumArtUrl) continue;

      this.logger?.info?.("Resolved TIDAL web artwork: " + (track.artist ? track.artist + " - " : "") + track.title);
      return {
        key,
        title: track.title,
        artist: track.artist,
        albumArtUrl,
        tidalUrl: normalizeTidalTrackUrl(extractTidalWebTrackUrl(html)) || searchUrl,
        source: "tidal-web"
      };
    }

    return null;
  }

  createTidalWebSearchUrl(query) {
    const base = this.tidalSearchBaseUrl || TIDAL_WEB_SEARCH_BASE_URL;
    return base.includes("{query}") ? base.replace("{query}", encodeURIComponent(query)) : base + encodeURIComponent(query);
  }

  async fetchText(url, options = {}) {
    const response = await this.fetchImpl(url, options);
    if (!response?.ok) {
      const error = new Error("HTTP " + (response?.status || "unknown"));
      error.status = response?.status;
      throw error;
    }
    return response.text();
  }

  async lookupTidalTrackDetails(candidate, track) {
    const trackId = cleanText(candidate?.id);
    if (!trackId) return null;

    const detailUrl = new URL(`${TIDAL_TRACK_ROOT}/${encodeURIComponent(trackId)}`);
    detailUrl.searchParams.set("countryCode", this.tidalCountryCode);
    detailUrl.searchParams.set("include", "albums,artists");

    const detailJson = await this.fetchTidalSearchJson(detailUrl.toString());
    const result = chooseTidalTrack(detailJson, track);
    if (result) return result;

    const trackResource = findTidalIncluded(detailJson, { id: trackId, type: "tracks" }, "tracks") || detailJson?.data || candidate;
    return this.lookupTidalAlbumCoverArt(trackResource, detailJson, track, getTidalTrackUrl(candidate));
  }

  async lookupTidalAlbumCoverArt(trackResource, searchJson, track, fallbackTidalUrl = "") {
    const albumRefs = getTidalAlbumRefs(trackResource);
    const includedAlbum = getTidalAlbum(trackResource, searchJson);
    if (cleanText(includedAlbum?.id)) albumRefs.push({ id: cleanText(includedAlbum.id), type: "albums" });

    const uniqueAlbumIds = Array.from(new Set(albumRefs.map((ref) => cleanText(ref?.id)).filter(Boolean)));
    for (const albumId of uniqueAlbumIds) {
      const album = await this.fetchTidalAlbum(albumId);
      const coverImage = await this.fetchTidalAlbumCoverImage(albumId, album);
      if (!coverImage) continue;

      return {
        title: cleanText(trackResource?.title || trackResource?.attributes?.title || track.title),
        album: cleanText(album?.data?.attributes?.title || album?.attributes?.title || includedAlbum?.title || includedAlbum?.attributes?.title),
        coverImage,
        durationMs: toDurationMs(trackResource?.duration || trackResource?.attributes?.duration, "seconds"),
        tidalUrl: getTidalTrackUrl(trackResource) || cleanText(fallbackTidalUrl)
      };
    }

    return null;
  }

  async fetchTidalAlbum(albumId) {
    const albumUrl = new URL(`${TIDAL_ALBUM_ROOT}/${encodeURIComponent(albumId)}`);
    albumUrl.searchParams.set("countryCode", this.tidalCountryCode);
    albumUrl.searchParams.set("include", "coverArt");
    return this.fetchTidalSearchJson(albumUrl.toString());
  }

  async fetchTidalAlbumCoverImage(albumId, albumJson = {}) {
    const candidates = [albumJson?.data, ...(Array.isArray(albumJson?.included) ? albumJson.included : [])];
    for (const candidate of candidates) {
      const coverImage = getTidalCoverArtUrl(candidate);
      if (coverImage) return coverImage;
    }

    const albumResource = albumJson?.data || {};
    const refs = getTidalCoverArtRefs(albumResource);
    if (!refs.length && cleanText(albumId)) {
      const relUrl = new URL(`${TIDAL_ALBUM_ROOT}/${encodeURIComponent(albumId)}/relationships/coverArt`);
      relUrl.searchParams.set("countryCode", this.tidalCountryCode);
      relUrl.searchParams.set("include", "coverArt");
      const relJson = await this.fetchTidalSearchJson(relUrl.toString());
      const relCandidates = [relJson?.data, ...(Array.isArray(relJson?.included) ? relJson.included : [])];
      for (const candidate of relCandidates) {
        const coverImage = getTidalCoverArtUrl(candidate);
        if (coverImage) return coverImage;
      }
    }

    return "";
  }

  async fetchTidalSearchJson(url) {
    const accessToken = await this.getTidalAccessToken();
    if (!accessToken) {
      throw new Error("TIDAL credentials missing: set TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET, or disable TIDAL_ARTWORK_LOOKUP");
    }

    try {
      return await this.fetchJson(url, { headers: this.createTidalHeaders(accessToken) });
    } catch (error) {
      if (error.status !== 401 || !this.tidalAccessToken || !this.tidalClientId || !this.tidalClientSecret) {
        throw error;
      }

      this.logger?.warn?.("Manual TIDAL access token was rejected; retrying with client credentials");
      const retryToken = await this.getTidalAccessToken({ ignoreManual: true });
      return this.fetchJson(url, { headers: this.createTidalHeaders(retryToken) });
    }
  }

  createTidalHeaders(accessToken) {
    return {
      accept: "application/vnd.api+json, application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    };
  }
  async getTidalAccessToken({ ignoreManual = false } = {}) {
    if ((!this.tidalClientId || !this.tidalClientSecret) && !ignoreManual && this.tidalAccessToken) {
      return this.tidalAccessToken;
    }
    if (!this.tidalClientId || !this.tidalClientSecret) return "";

    const now = this.clock();
    if (this.tidalToken?.accessToken && this.tidalToken.expiresAtMs - now > 60_000) {
      return this.tidalToken.accessToken;
    }

    if (typeof this.fetchImpl !== "function") throw new Error("fetch is not available");

    const body = new URLSearchParams({ grant_type: "client_credentials" });
    const auth = Buffer.from(`${this.tidalClientId}:${this.tidalClientSecret}`, "utf8").toString("base64");
    const response = await this.fetchImpl(TIDAL_TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body
    });

    let json;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok || !json?.access_token) {
      const message = json?.error_description || json?.error || `HTTP ${response.status}`;
      throw new Error(`TIDAL token request failed: ${message}`);
    }

    const expiresInMs = Math.max(60, Number(json.expires_in || 3600)) * 1000;
    this.tidalToken = {
      accessToken: cleanText(json.access_token),
      expiresAtMs: now + expiresInMs
    };
    this.logger?.info?.("Fetched TIDAL access token with client credentials");
    return this.tidalToken.accessToken;
  }
  async prepareAlbumArtUrl(sourceUrl, key) {
    const cleanUrl = cleanText(sourceUrl);
    if (!cleanUrl) return "";
    if (!this.albumArtProvider?.cachePublicUrl) return cleanUrl;

    try {
      return await this.albumArtProvider.cachePublicUrl(cleanUrl, `radio:${key}`);
    } catch (error) {
      let sourceHost = "";
      try {
        sourceHost = new URL(cleanUrl).host;
      } catch {
        sourceHost = "invalid-url";
      }
      this.logger?.warn?.("Album art proxy cache failed", { error: describeError(error), sourceHost });
      return "";
    }
  }

  async lookupDiscogs(track, key) {
    if (!this.discogsEnabled || !this.discogsToken) return null;

    try {
      return await this.searchDiscogs(track, key);
    } catch (error) {
      this.logger?.debug?.("Discogs lookup failed", { error: describeError(error) });
      return null;
    }
  }

  async searchDiscogs(track, key) {
    const searches = [];
    if (track.artist) {
      searches.push({ artist: track.artist, track: track.title });
      searches.push({ q: `${track.artist} ${track.title}` });
    }
    searches.push({ q: track.title });

    for (const params of searches) {
      const searchUrl = new URL("https://api.discogs.com/database/search");
      searchUrl.searchParams.set("type", "release");
      searchUrl.searchParams.set("per_page", "5");
      for (const [name, value] of Object.entries(params)) {
        if (value) searchUrl.searchParams.set(name, value);
      }

      const searchJson = await this.fetchJson(searchUrl.toString(), {
        headers: {
          authorization: `Discogs token=${this.discogsToken}`
        }
      });
      const result = chooseDiscogsResult(searchJson, track);
      if (!result) continue;

      const albumArtUrl = await this.prepareAlbumArtUrl(result.coverImage, key);
      if (!albumArtUrl) continue;

      return {
        key,
        title: track.title,
        artist: track.artist,
        album: cleanText(result.title),
        albumArtUrl,
        source: "discogs"
      };
    }

    return null;
  }

  async searchRecordings(track) {
    const queries = [];
    if (track.artist) {
      queries.push(`recording:"${track.title}" AND artist:"${track.artist}"`);
    }
    queries.push(`recording:"${track.title}"`);

    for (const query of queries) {
      const searchUrl = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5&inc=releases+artist-credits`;
      const searchJson = await this.fetchJson(searchUrl);
      const recordings = Array.isArray(searchJson?.recordings) ? searchJson.recordings : [];
      if (recordings.length) return recordings;
    }

    return [];
  }

  remember(key, entry) {
    this.cache.delete(key);
    this.cache.set(key, entry);

    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  updateConfig({ enabled, cacheMax, minLookupIntervalMs, spotifyArtworkEnabled, spotifyMarket, spotifyClientId, spotifyClientSecret, tidalArtworkEnabled, tidalCountryCode, tidalSearchBaseUrl, tidalAccessToken, tidalClientId, tidalClientSecret, discogsEnabled, discogsToken, albumArtProvider } = {}) {
    const nextEnabled = enabled !== undefined ? !!enabled : this.enabled;
    const nextCacheMax = Number(cacheMax) || this.cacheMax;
    const nextMinLookupIntervalMs = Number(minLookupIntervalMs) || this.minLookupIntervalMs;
    const nextSpotifyArtworkEnabled = spotifyArtworkEnabled !== undefined ? !!spotifyArtworkEnabled : this.spotifyArtworkEnabled;
    const nextSpotifyMarket = spotifyMarket !== undefined ? cleanText(spotifyMarket || "US") || "US" : this.spotifyMarket;
    const nextSpotifyClientId = spotifyClientId !== undefined ? cleanText(spotifyClientId) : this.spotifyClientId;
    const nextSpotifyClientSecret = spotifyClientSecret !== undefined ? cleanText(spotifyClientSecret) : this.spotifyClientSecret;
    const nextTidalArtworkEnabled = tidalArtworkEnabled !== undefined ? !!tidalArtworkEnabled : this.tidalArtworkEnabled;
    const nextTidalCountryCode = tidalCountryCode !== undefined ? cleanText(tidalCountryCode || "US") || "US" : this.tidalCountryCode;
    const nextTidalSearchBaseUrl = tidalSearchBaseUrl !== undefined ? cleanText(tidalSearchBaseUrl || TIDAL_WEB_SEARCH_BASE_URL) || TIDAL_WEB_SEARCH_BASE_URL : this.tidalSearchBaseUrl;
    const nextTidalAccessToken = tidalAccessToken !== undefined ? cleanText(tidalAccessToken) : this.tidalAccessToken;
    const nextTidalClientId = tidalClientId !== undefined ? cleanText(tidalClientId) : this.tidalClientId;
    const nextTidalClientSecret = tidalClientSecret !== undefined ? cleanText(tidalClientSecret) : this.tidalClientSecret;
    const nextDiscogsEnabled = discogsEnabled !== undefined ? !!discogsEnabled : this.discogsEnabled;
    const nextDiscogsToken = discogsToken !== undefined ? cleanText(discogsToken) : this.discogsToken;
    const nextAlbumArtProvider = albumArtProvider !== undefined ? albumArtProvider : this.albumArtProvider;
    const changed =
      nextEnabled !== this.enabled ||
      nextCacheMax !== this.cacheMax ||
      nextMinLookupIntervalMs !== this.minLookupIntervalMs ||
      nextTidalArtworkEnabled !== this.tidalArtworkEnabled ||
      nextTidalCountryCode !== this.tidalCountryCode ||
      nextTidalAccessToken !== this.tidalAccessToken ||
      nextTidalClientId !== this.tidalClientId ||
      nextTidalClientSecret !== this.tidalClientSecret ||
      nextDiscogsEnabled !== this.discogsEnabled ||
      nextDiscogsToken !== this.discogsToken ||
      nextAlbumArtProvider !== this.albumArtProvider;

    if (!changed) return false;

    this.enabled = nextEnabled;
    this.cacheMax = nextCacheMax;
    this.minLookupIntervalMs = nextMinLookupIntervalMs;
    this.tidalArtworkEnabled = nextTidalArtworkEnabled;
    this.tidalCountryCode = nextTidalCountryCode;
    this.tidalAccessToken = nextTidalAccessToken;
    this.tidalClientId = nextTidalClientId;
    this.tidalClientSecret = nextTidalClientSecret;
    this.tidalToken = null;
    this.discogsEnabled = nextDiscogsEnabled;
    this.discogsToken = nextDiscogsToken;
    this.albumArtProvider = nextAlbumArtProvider;
    this.cache.clear();
    return true;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.pending.clear();
  }
}

module.exports = {
  RadioMetadataResolver,
  parseRadioTrack,
  makeLookupKey,
  chooseCoverImage,
  chooseRelease,
  chooseDiscogsResult,
  chooseTidalTrack,
  tidalCoverUrlFromUuid,
  extractTidalWebArtwork,
  stripGuestCredit,
  getRadioStationName
};
