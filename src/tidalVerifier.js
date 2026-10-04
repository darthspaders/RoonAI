"use strict";
const { captureTidalEvidence } = require("./providerSourceEvidence");

const fs = require("fs");
const path = require("path");
const USER_AGENT = "RoonLocalAI/0.1.0";
const TIDAL_TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";
const { createSearchUrl, searchRelationForUrl, toLegacySearchShape } = require("./tidalSearchCompat");
const TIDAL_TRACK_ROOT = "https://openapi.tidal.com/v2/tracks";
const TIDAL_LEGACY_SEARCH_URL = "https://api.tidal.com/v1/search/tracks";
const DEFAULT_TIDAL_CATALOG_PAGINATION_FILE = path.join(__dirname, "..", "data", "tidal-catalog-pagination.json");
const DEFAULT_TIDAL_ARTIST_ALIAS_FILE = path.join(__dirname, "..", "data", "tidal-artist-aliases.json");
const TIDAL_CATALOG_PAGINATION_VERSION = 1;
const {
  CircuitBreaker,
  DEFAULT_TIDAL_CIRCUIT_COOLDOWN_MS,
  DEFAULT_TIDAL_CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_TIDAL_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  httpStatusError,
  positiveNumber
} = require("./tidalRequestGuard");
const { normalizeTidalTrackUrl } = require("./tidalIdentity");
const {
  chooseExact,
  scoreTidalIdentity,
  canonicalTwelveInchClubEvidence,
  normalizeDisambiguationOptions,
  IDENTITY_DISAMBIGUATION_DEFAULTS
} = require("./exactTrackVerification");
const {
  foldUnicode,
  normalizeCatalogText,
  artistCreditSetKey,
  normalizeArtistCreditNames,
  parseCanonicalCatalogIdentity,
  normalizeAlbumFamily,
  stripVersionDescriptorFromTitle,
  stripFeaturedArtistText
} = require("./catalogIdentityNormalization");
const { DEFAULT_LEGACY_ARTIST_ALIASES } = require("./legacyArtistAliases");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function paginationLink(value) {
  if (typeof value === "string") return cleanText(value);
  if (!value || typeof value !== "object") return "";
  return cleanText(value.href || value.url || value.next || "");
}

function paginationCursorFromUrl(value) {
  try {
    const url = new URL(value);
    return cleanText(url.searchParams.get("page[cursor]") || url.searchParams.get("cursor"));
  } catch {
    return "";
  }
}

function paginationPageFromUrl(value) {
  try {
    const url = new URL(value);
    return finiteNumberOrNull(url.searchParams.get("page[number]") || url.searchParams.get("page"));
  } catch {
    return null;
  }
}

function paginationOffsetFromUrl(value) {
  try {
    const url = new URL(value);
    return finiteNumberOrNull(url.searchParams.get("offset") || url.searchParams.get("page[offset]"));
  } catch {
    return null;
  }
}

function paginationDescriptorForUrl(value, fallbackUrl = "") {
  const url = cleanText(value || fallbackUrl);
  const cursor = paginationCursorFromUrl(url);
  if (cursor) return { kind: "cursor", cursor, page: null, offset: null, url };
  const offset = paginationOffsetFromUrl(url);
  if (offset !== null) return { kind: "offset", cursor: "", page: null, offset, url };
  const page = paginationPageFromUrl(url);
  if (page !== null) return { kind: "page", cursor: "", page, offset: null, url };
  return { kind: "page", cursor: "", page: 1, offset: null, url };
}

function normalizeCatalogPaginationUrl(value, baseUrl = "") {
  try {
    const next = new URL(value, baseUrl);
    const base = new URL(baseUrl || value);
    // Some TIDAL v2 responses emit relationship links without the `/v2`
    // prefix even though the current catalog endpoint requires it. Preserve
    // the returned path/query, but repair that provider link before caching
    // or following it.
    if (base.origin === next.origin && base.pathname.startsWith("/v2/") && !next.pathname.startsWith("/v2/")) {
      next.pathname = `/v2${next.pathname}`;
    }
    // Cursor links (including saved links) may omit or retain an older include
    // shape. Every page needs the same related metadata as this request.
    if (base.origin === next.origin) {
      for (const key of ["countryCode", "include", "explicitFilter"]) {
        if (base.searchParams.has(key)) next.searchParams.set(key, base.searchParams.get(key));
      }
    }
    return next.toString();
  } catch {
    return cleanText(value);
  }
}

function paginationRequestKey(descriptor = {}) {
  if (descriptor.cursor) return `cursor:${descriptor.cursor}`;
  if (descriptor.offset !== null && descriptor.offset !== undefined) return `offset:${descriptor.offset}`;
  return `page:${Number(descriptor.page || 1)}`;
}

function firstPaginationValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    return value;
  }
  return null;
}

function paginationMetadataObjects(searchJson = {}) {
  return [
    searchJson?.meta,
    searchJson?.pagination,
    searchJson?.page
  ].filter((value) => value && typeof value === "object");
}

function nextPaginationFrom(searchJson = {}, requestUrl = "", { relationshipNames = [] } = {}) {
  const candidates = [];
  const data = Array.isArray(searchJson?.data) ? searchJson.data : (searchJson?.data ? [searchJson.data] : []);
  for (const item of data) {
    for (const relationshipName of relationshipNames) {
      const relationship = item?.relationships?.[relationshipName];
      if (!relationship) continue;
      candidates.push(relationship.links?.next, relationship.meta?.next, relationship.meta?.links?.next);
    }
  }
  candidates.push(searchJson?.links?.next, searchJson?.meta?.links?.next, searchJson?.pagination?.links?.next);

  for (const candidate of candidates) {
    const link = paginationLink(candidate);
    if (!link) continue;
    const url = normalizeCatalogPaginationUrl(link, requestUrl);
    if (!url) continue;
    const descriptor = paginationDescriptorForUrl(url, requestUrl);
    if (paginationRequestKey(descriptor) === paginationRequestKey(paginationDescriptorForUrl(requestUrl))) return null;
    return descriptor;
  }

  const metadata = paginationMetadataObjects(searchJson);
  const cursor = cleanText(firstPaginationValue(
    ...metadata.map((value) => value.nextCursor || value.next_cursor || value.cursor?.next),
    searchJson?.nextCursor,
    searchJson?.next_cursor
  ));
  if (cursor) {
    const url = new URL(requestUrl);
    url.searchParams.set("page[cursor]", cursor);
    const descriptor = paginationDescriptorForUrl(url.toString(), requestUrl);
    return paginationRequestKey(descriptor) === paginationRequestKey(paginationDescriptorForUrl(requestUrl)) ? null : descriptor;
  }

  const explicitNextPage = firstPaginationValue(
    ...metadata.map((value) => value.nextPage || value.next_page || value.page?.next),
    searchJson?.nextPage,
    searchJson?.next_page,
    searchJson?.page?.next
  );
  const currentPage = firstPaginationValue(
    ...metadata.map((value) => value.page?.current || value.page?.number || value.currentPage || value.current_page),
    searchJson?.page?.current,
    searchJson?.page?.number,
    paginationPageFromUrl(requestUrl)
  );
  const totalPages = firstPaginationValue(
    ...metadata.map((value) => value.totalPages || value.total_pages || value.page?.totalPages || value.page?.total_pages),
    searchJson?.totalPages,
    searchJson?.total_pages
  );
  const nextPage = finiteNumberOrNull(explicitNextPage) ?? (
    finiteNumberOrNull(currentPage) !== null && finiteNumberOrNull(totalPages) !== null &&
    finiteNumberOrNull(currentPage) < finiteNumberOrNull(totalPages)
      ? finiteNumberOrNull(currentPage) + 1
      : null
  );
  if (nextPage !== null) {
    const url = new URL(requestUrl);
    const pageParam = url.searchParams.has("page[number]") ? "page[number]" : "page";
    url.searchParams.set(pageParam, String(nextPage));
    const descriptor = paginationDescriptorForUrl(url.toString(), requestUrl);
    return paginationRequestKey(descriptor) === paginationRequestKey(paginationDescriptorForUrl(requestUrl)) ? null : descriptor;
  }

  const explicitNextOffset = firstPaginationValue(
    ...metadata.map((value) => value.nextOffset || value.next_offset || value.offset?.next),
    searchJson?.nextOffset,
    searchJson?.next_offset
  );
  const currentOffset = firstPaginationValue(
    ...metadata.map((value) => value.offset?.current ?? value.offset),
    searchJson?.offset,
    paginationOffsetFromUrl(requestUrl)
  );
  const pageSize = firstPaginationValue(
    ...metadata.map((value) => value.limit || value.pageSize || value.page_size || value.offset?.limit),
    searchJson?.limit,
    new URL(requestUrl).searchParams.get("limit")
  );
  const total = firstPaginationValue(
    ...metadata.map((value) => value.total || value.offset?.total),
    searchJson?.total
  );
  const nextOffset = finiteNumberOrNull(explicitNextOffset) ?? (
    finiteNumberOrNull(currentOffset) !== null && finiteNumberOrNull(pageSize) !== null && finiteNumberOrNull(total) !== null &&
    finiteNumberOrNull(currentOffset) + finiteNumberOrNull(pageSize) < finiteNumberOrNull(total)
      ? finiteNumberOrNull(currentOffset) + finiteNumberOrNull(pageSize)
      : null
  );
  if (nextOffset !== null) {
    const url = new URL(requestUrl);
    const offsetParam = url.searchParams.has("page[offset]") ? "page[offset]" : "offset";
    url.searchParams.set(offsetParam, String(nextOffset));
    const descriptor = paginationDescriptorForUrl(url.toString(), requestUrl);
    return paginationRequestKey(descriptor) === paginationRequestKey(paginationDescriptorForUrl(requestUrl)) ? null : descriptor;
  }

  return null;
}

function catalogItemIdentity(item = {}, searchJson = {}) {
  const type = cleanText(item.type || "tracks");
  const id = cleanText(item.id || item.trackId || item.albumId || item.artistId);
  if (id) return `${type}:${id}`;
  const title = cleanText(item.title || item.attributes?.title);
  const artists = getArtistNames(item, searchJson).join(", ");
  const fallback = normalizeMatchText(`${artists} ${title}`);
  return fallback ? `${type}:${fallback}` : "";
}

function collectionItems(searchJson = {}, type = "") {
  const included = getIncluded(searchJson, type);
  const data = Array.isArray(searchJson?.data) ? searchJson.data : (searchJson?.data ? [searchJson.data] : []);
  const refs = data
    .filter((item) => cleanText(item?.type) === type)
    .map((item) => findIncluded(searchJson, item, type) || item);
  const related = data.flatMap((item) => Object.values(item?.relationships || {})
    .flatMap((relationship) => Array.isArray(relationship?.data) ? relationship.data : []))
    .filter((item) => cleanText(item?.type) === type)
    .map((item) => findIncluded(searchJson, item, type) || item);
  return [...included, ...refs, ...related];
}

function albumTrackItems(searchJson = {}) {
  return collectionItems(searchJson, "tracks");
}

class TidalCatalogProgressStore {
  constructor({ file = DEFAULT_TIDAL_CATALOG_PAGINATION_FILE, clock = () => Date.now() } = {}) {
    this.file = file || DEFAULT_TIDAL_CATALOG_PAGINATION_FILE;
    this.clock = clock;
    this.state = this.read();
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const entries = parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {};
      return { version: TIDAL_CATALOG_PAGINATION_VERSION, updatedAt: parsed.updatedAt || null, entries };
    } catch {
      return { version: TIDAL_CATALOG_PAGINATION_VERSION, updatedAt: null, entries: {} };
    }
  }

  get(key) {
    const entry = this.state.entries[key];
    if (!entry || typeof entry !== "object") return null;
    return {
      ...entry,
      next: entry.next && typeof entry.next === "object" ? { ...entry.next } : null,
      seenRows: Array.isArray(entry.seenRows) ? [...entry.seenRows] : []
    };
  }

  set(key, entry = {}) {
    const seenRows = Array.from(new Set((Array.isArray(entry.seenRows) ? entry.seenRows : []).map(cleanText).filter(Boolean))).slice(-5000);
    this.state.entries[key] = {
      version: TIDAL_CATALOG_PAGINATION_VERSION,
      source: cleanText(entry.source),
      anchor: cleanText(entry.anchor),
      next: entry.next && typeof entry.next === "object" ? { ...entry.next } : null,
      exhausted: Boolean(entry.exhausted),
      seenRows,
      lastRequested: entry.lastRequested && typeof entry.lastRequested === "object" ? { ...entry.lastRequested } : null,
      lastNext: entry.lastNext && typeof entry.lastNext === "object" ? { ...entry.lastNext } : null,
      updatedAt: new Date(this.clock()).toISOString()
    };
    this.state.updatedAt = new Date(this.clock()).toISOString();
    this.write();
    return this.get(key);
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporary, this.file);
  }

  size() {
    return Object.keys(this.state.entries || {}).length;
  }
}

function normalizeMatchText(value) {
  return normalizeCatalogText(cleanText(value));
}

function normalizeSearchQuery(value) {
  return cleanText(foldUnicode(value))
    .replace(/&/g, " ")
    .replace(/[^\p{L}\p{N}()]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeExactSearchQuery(value) {
  return cleanText(foldUnicode(value))
    .replace(/&/g, " ")
    .replace(/[,;/+|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLooseSearchQuery(value) {
  return normalizeSearchQuery(value)
    .replace(/[()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getArtistLookupAliases(value) {
  const artist = cleanText(value);
  if (!artist) return [];

  // Keep the complete credit and add exact component credits. The shared
  // splitter intentionally understands commas, &, and/vs separators, while
  // still refusing fuzzy artist-name substitutions.
  const aliases = [artist, ...normalizeArtistCreditNames(artist)];

  return Array.from(new Set(aliases));
}

function aliasRecordList(value) {
  if (!value) return [];
  if (typeof value === "string") {
    try { return aliasRecordList(JSON.parse(value)); } catch { return []; }
  }
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.mappings)) return value.mappings;
  if (typeof value === "object") {
    return Object.entries(value).map(([canonicalArtistIdentity, aliases]) => ({
      canonicalArtistIdentity,
      aliases: Array.isArray(aliases) ? aliases : [aliases],
      source: "configured"
    }));
  }
  return [];
}

function aliasRecordNames(record = {}) {
  return [
    record.canonicalArtistIdentity,
    record.canonical,
    record.artist,
    record.name,
    ...(Array.isArray(record.aliases) ? record.aliases : []),
    ...(Array.isArray(record.artistAliases) ? record.artistAliases : [])
  ].map(cleanText).filter(Boolean);
}

function aliasRecordIds(record = {}) {
  return [
    ...(Array.isArray(record.artistIds) ? record.artistIds : []),
    ...(Array.isArray(record.tidalArtistIds) ? record.tidalArtistIds : []),
    ...(Array.isArray(record.beatportArtistIds) ? record.beatportArtistIds : []),
    record.tidalArtistId,
    record.beatportArtistId
  ].map(cleanText).filter(Boolean);
}

function loadArtistAliasRecords(value, file = "") {
  const configured = aliasRecordList(value);
  const fromFile = configured.length || !file
    ? []
    : (() => { try { return aliasRecordList(fs.readFileSync(file, "utf8")); } catch { return []; } })();
  const external = configured.length ? configured : fromFile;
  const canonicalKeys = new Set(external
    .map(record => normalizeMatchText(record.canonicalArtistIdentity || record.canonical || record.artist || record.name))
    .filter(Boolean));
  const defaults = DEFAULT_LEGACY_ARTIST_ALIASES.filter(record => !canonicalKeys.has(normalizeMatchText(record.canonicalArtistIdentity)));
  return [...defaults, ...external];
}

function artistLookupContext(track = {}, aliasRecords = []) {
  const requested = cleanText(track.artist);
  const requestedKey = normalizeMatchText(requested);
  const requestedCreditKeys = new Set([
    requestedKey,
    ...getArtistLookupAliases(requested).map(normalizeMatchText)
  ].filter(Boolean));
  const requestedIds = new Set([
    track.tidalArtistId,
    track.beatportArtistId,
    ...(Array.isArray(track.tidalArtistIds) ? track.tidalArtistIds : []),
    ...(Array.isArray(track.beatportArtistIds) ? track.beatportArtistIds : [])
  ].map(cleanText).filter(Boolean));
  const metadataAliases = [
    ...(Array.isArray(track.artistAliases) ? track.artistAliases : []),
    track.canonicalArtistIdentity
  ].map(cleanText).filter(Boolean);
  const matchedRecords = aliasRecords.filter(record => {
    const names = new Set(aliasRecordNames(record).map(normalizeMatchText).filter(Boolean));
    const ids = new Set(aliasRecordIds(record));
    return (requestedKey && names.has(requestedKey)) || [...requestedIds].some(id => ids.has(id));
  });
  const aliases = new Map();
  const add = (value, source = "requested") => {
    const name = cleanText(value);
    const key = normalizeMatchText(name);
    if (name && key && !aliases.has(key)) aliases.set(key, { name, source });
  };
  add(requested);
  metadataAliases.forEach(alias => add(alias, "track-metadata"));
  for (const record of matchedRecords) {
    const source = cleanText(record.source) || "configured";
    aliasRecordNames(record).forEach(name => add(name, source));
  }
  const requestedEntry = aliases.get(requestedKey);
  const canonicalArtistIdentity = cleanText(
    matchedRecords.map(record => record.canonicalArtistIdentity || record.canonical || record.artist || record.name).find(Boolean)
      || track.canonicalArtistIdentity
      || requested
  );
  const aliasValues = [...aliases.values()];
  const mappedIds = new Set(matchedRecords.flatMap(aliasRecordIds));
  const aliasCreditSetKeys = new Set([
    artistCreditSetKey(requested),
    ...metadataAliases.map(artistCreditSetKey),
    ...matchedRecords.flatMap(record => aliasRecordNames(record).map(artistCreditSetKey))
  ].filter(Boolean));
  return {
    requested,
    requestedKey,
    requestedCreditKeys,
    requestedIds,
    mappedIds,
    aliases: aliasValues.map(entry => entry.name),
    aliasKeys: new Set(aliasValues.map(entry => normalizeMatchText(entry.name)).filter(Boolean)),
    aliasSources: [...new Set(aliasValues.filter(entry => entry.source !== "requested").map(entry => entry.source))],
    aliasLookupApplied: aliasValues.some(entry => entry.source !== "requested"),
    canonicalArtistIdentity: canonicalArtistIdentity || requested,
    canonicalArtistCredits: normalizeArtistCreditNames(canonicalArtistIdentity || requested),
    requestedCreditSetKey: artistCreditSetKey(requested),
    aliasCreditSetKeys,
    matchedRecords,
    requestedEntry
  };
}

function expectedLegacyEraEvidenceForTrack(track = {}) {
  const releaseEvidence = track.releaseEvidence && typeof track.releaseEvidence === "object" ? track.releaseEvidence : {};
  const metadata = track.metadata && typeof track.metadata === "object" ? track.metadata : {};
  const album = typeof track.album === "object" ? track.album : {};
  const validatedIdentity = track.validatedIdentity && typeof track.validatedIdentity === "object" ? track.validatedIdentity : {};
  const candidates = [
    ["supplied-release-year", [track.releaseYear, track.releaseDate, track.year]],
    ["supplied-album-year", [track.albumYear, album.year, album.releaseYear, metadata.albumYear]],
    ["supplied-recording-year", [track.recordingYear, track.originalReleaseYear, track.originalYear]],
    ["tidal-recording-year", [releaseEvidence.recordingYear, track.tidalRecordingYear, track.tidalOriginalReleaseYear]],
    ["tidal-catalog-year", [releaseEvidence.catalogReleaseYear, track.catalogReleaseYear, track.tidalCatalogReleaseYear]],
    ["isrc-year", [releaseEvidence.isrcYear, track.isrcYear]],
    ["beatport-original-release-year", [track.beatport?.originalReleaseYear, track.beatport?.recordingYear, track.beatportOriginalReleaseYear]],
    ["earliest-trusted-provider-appearance", [track.earliestTrustedProviderYear, track.firstTrustedProviderYear]],
    ["artist-release-lineage", [track.artistReleaseLineageYear, track.releaseLineageYear]],
    ["validated-identity-release-year", [validatedIdentity.releaseYear, validatedIdentity.releaseDate, validatedIdentity.year]],
    ["validated-identity-recording-year", [validatedIdentity.recordingYear, validatedIdentity.originalReleaseYear, validatedIdentity.originalYear]],
    ["validated-identity-album-year", [validatedIdentity.albumYear, validatedIdentity.album?.year]]
  ];
  for (const [source, values] of candidates) {
    for (const value of values) {
      const match = cleanText(value).match(/\b(19\d{2}|20\d{2})\b/);
      if (match) return { year: Number(match[1]), source };
    }
  }
  return { year: null, source: "" };
}

function expectedLegacyEraForTrack(track = {}) {
  return expectedLegacyEraEvidenceForTrack(track).year;
}

function buildExactSearchPlans(track = {}, { strict = false, aliasRecords = [] } = {}) {
  const parsed = parseCanonicalCatalogIdentity(track);
  const fullTitle = cleanText(track.title || track.name);
  const baseTitle = cleanText(stripFeaturedArtistText(stripVersionDescriptorFromTitle(fullTitle))) || parsed.normalizedBaseTitle;
  const artistContext = artistLookupContext(track, aliasRecords);
  const requestedArtist = cleanText(track.artist);
  const album = cleanText(typeof track.album === "object" ? track.album.title : track.album || track.releaseTitle);
  const expectedLegacyEraEvidence = expectedLegacyEraEvidenceForTrack(track);
  const expectedLegacyEra = expectedLegacyEraEvidence.year;
  const plans = [];
  const seen = new Set();
  const add = (label, query, flags = {}) => {
    const normalizedQuery = normalizeExactSearchQuery(query);
    if (!normalizedQuery || seen.has(normalizedQuery)) return;
    seen.add(normalizedQuery);
    plans.push({
      searchStage: label,
      query: normalizedQuery,
      candidateSourceQuery: normalizedQuery,
      artistConstraintApplied: Boolean(flags.artistConstraintApplied),
      titleConstraintApplied: Boolean(flags.titleConstraintApplied),
      albumConstraintApplied: Boolean(flags.albumConstraintApplied),
      eraConstraintApplied: Boolean(flags.eraConstraintApplied),
      titleOnlyFallback: Boolean(flags.titleOnlyFallback),
      expectedLegacyEra,
      expectedLegacyEraSource: expectedLegacyEraEvidence.source,
      artistAliasApplied: Boolean(flags.artistAliasApplied),
      aliasSource: flags.aliasSource || ""
    });
  };

  if (requestedArtist && fullTitle) add("exact-artist-title", `${requestedArtist} ${fullTitle}`, { artistConstraintApplied: true, titleConstraintApplied: true });
  if (requestedArtist && baseTitle && baseTitle !== fullTitle) add("exact-artist-base-title", `${requestedArtist} ${baseTitle}`, { artistConstraintApplied: true, titleConstraintApplied: true });

  const alternateArtists = artistContext.aliases.filter(name => normalizeMatchText(name) !== artistContext.requestedKey);
  for (const artist of alternateArtists) {
    const aliasSource = aliasValuesSource(artist, artistContext);
    if (fullTitle) add("artist-alias-title", `${artist} ${fullTitle}`, { artistConstraintApplied: true, titleConstraintApplied: true, artistAliasApplied: true, aliasSource });
    if (baseTitle) add("artist-alias-base-title", `${artist} ${baseTitle}`, { artistConstraintApplied: true, titleConstraintApplied: true, artistAliasApplied: true, aliasSource });
  }

  if (requestedArtist && album && baseTitle) add("artist-album-base-title", `${requestedArtist} ${album} ${baseTitle}`, { artistConstraintApplied: true, titleConstraintApplied: true, albumConstraintApplied: true });
  for (const artist of alternateArtists) {
    if (album && baseTitle) add("artist-alias-album-base-title", `${artist} ${album} ${baseTitle}`, { artistConstraintApplied: true, titleConstraintApplied: true, albumConstraintApplied: true, artistAliasApplied: true, aliasSource: aliasValuesSource(artist, artistContext) });
  }

  if (requestedArtist && expectedLegacyEra && baseTitle) add("artist-era-base-title", `${requestedArtist} ${baseTitle} ${expectedLegacyEra}`, { artistConstraintApplied: true, titleConstraintApplied: true, eraConstraintApplied: true });
  for (const artist of alternateArtists) {
    if (expectedLegacyEra && baseTitle) add("artist-alias-era-base-title", `${artist} ${baseTitle} ${expectedLegacyEra}`, { artistConstraintApplied: true, titleConstraintApplied: true, eraConstraintApplied: true, artistAliasApplied: true, aliasSource: aliasValuesSource(artist, artistContext) });
  }

  if (!strict) {
    if (fullTitle) add("title-only-fallback", fullTitle, { titleConstraintApplied: true, titleOnlyFallback: true });
    if (baseTitle) add("base-title-only-fallback", baseTitle, { titleConstraintApplied: true, titleOnlyFallback: true });
  }
  return plans;
}

function aliasValuesSource(name, context) {
  const key = normalizeMatchText(name);
  const record = context?.matchedRecords?.find(entry => aliasRecordNames(entry).some(value => normalizeMatchText(value) === key));
  return cleanText(record?.source) || "track-metadata";
}

function getTitleMatchKeys(value) {
  const identity = parseCanonicalCatalogIdentity({ title: value });
  return Array.from(new Set([
    normalizeMatchText(value),
    identity.normalizedBaseTitle
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
  const resultIdentity = parseCanonicalCatalogIdentity({ title: resultTitle });
  const trackIdentity = parseCanonicalCatalogIdentity({ title: trackTitle });
  const resultBase = resultIdentity.normalizedBaseTitle;
  const trackBase = trackIdentity.normalizedBaseTitle;
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
  const candidate = item?.source === "tidal" && item.artist
    ? item
    : buildResult(item, searchJson, "");
  const identity = scoreTidalIdentity(track, candidate);
  if (!identity.matched) return 0;
  // Keep the existing title/artist score scale for callers and thresholds,
  // but let the shared identity evidence scorer reject unsafe version and
  // artist substitutions before a result can be considered exact.
  return titleScore + artistScore + Math.round(identity.confidenceScore * 36);
}

function createSearchQueries(track, { strict = false } = {}) {
  return buildExactSearchPlans(track, { strict }).map(plan => plan.query);
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

  return [cleanText(
    (typeof item.artist === "string" ? item.artist : item.artist?.name) ||
    item.artistName ||
    item.attributes?.artistName
  )].filter(Boolean);
}

function getArtistIds(item = {}, searchJson = {}) {
  const artists = Array.isArray(item.artists) ? item.artists : [];
  const flatIds = artists.map((artist) => cleanText(artist?.id || artist?.artistId || artist?.artist_id)).filter(Boolean);
  const relationshipIds = getRelationshipData(item, "artists")
    .map((ref) => cleanText(ref?.id))
    .filter(Boolean);
  const includedIds = getRelationshipData(item, "artists")
    .map((ref) => findIncluded(searchJson, ref, "artists"))
    .map((artist) => cleanText(artist?.id))
    .filter(Boolean);
  return [...new Set([...flatIds, ...relationshipIds, ...includedIds])];
}

function getArtistRefs(item = {}, searchJson = {}) {
  const names = getArtistNames(item, searchJson);
  const ids = getArtistIds(item, searchJson);
  return names.map((name, index) => ({
    name,
    id: ids[index] || ""
  })).filter((artist) => artist.name || artist.id);
}

function getAlbum(item = {}, searchJson = {}) {
  const flatAlbum = item.album || {};
  if (flatAlbum.title || flatAlbum.attributes?.title) return flatAlbum;

  const ref = getRelationshipData(item, "albums")[0] || getRelationshipData(item, "album")[0];
  return findIncluded(searchJson, ref, "albums") || {};
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

function imageUrlFromArtworkObject(artwork = {}) {
  const files = Array.isArray(artwork.attributes?.files) ? artwork.attributes.files : [];
  const fileUrl = files
    .map((file) => ({
      href: cleanText(file?.href || file?.url),
      width: Number(file?.meta?.width || 0),
      height: Number(file?.meta?.height || 0)
    }))
    .filter((file) => /^https?:\/\//i.test(file.href))
    .sort((left, right) => (right.width * right.height) - (left.width * left.height))[0]?.href || "";
  if (fileUrl) return fileUrl;
  return imageUrlFromLinks(artwork.attributes?.imageLinks || artwork.imageLinks || artwork.links);
}

function imageUrlFromCoverArtRelationship(album = {}, searchJson = {}) {
  const refs = getRelationshipData(album, "coverArt");
  for (const ref of refs) {
    const artwork = findIncluded(searchJson, ref, "artworks");
    const imageUrl = imageUrlFromArtworkObject(artwork);
    if (imageUrl) return imageUrl;
    const fallbackUrl = imageUrlFromTidalId(ref?.id);
    if (fallbackUrl) return fallbackUrl;
  }
  return "";
}

function getImageUrl(item = {}, album = {}, searchJson = {}) {
  const linkUrl = imageUrlFromLinks(album.imageLinks || album.attributes?.imageLinks || item.imageLinks || item.attributes?.imageLinks);
  if (linkUrl) return linkUrl;

  const coverArtUrl = imageUrlFromCoverArtRelationship(album, searchJson);
  if (coverArtUrl) return coverArtUrl;

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

function searchNeedsDetailExpansion(searchJson = {}) {
  return getItems(searchJson).some((item) => {
    const album = getAlbum(item, searchJson);
    return !getArtistNames(item, searchJson).length || !cleanText(album.title || album.attributes?.title);
  });
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

function getIsrc(item = {}) {
  return cleanText(item.isrc || item.attributes?.isrc).replace(/[^a-z0-9]/gi, "").toUpperCase();
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
  const recordingYear = firstYear([
    item.originalReleaseDate,
    item.attributes?.originalReleaseDate,
    album.originalReleaseDate,
    album.attributes?.originalReleaseDate
  ]);
  const catalogReleaseYear = firstYear([
    item.releaseDate,
    item.attributes?.releaseDate,
    album.releaseDate,
    album.attributes?.releaseDate,
    item.releaseYear,
    item.attributes?.releaseYear,
    album.releaseYear,
    album.attributes?.releaseYear
  ]);
  return {
    recordingYear,
    catalogReleaseYear,
    reissueYear: recordingYear && catalogReleaseYear && catalogReleaseYear > recordingYear + 1
      ? catalogReleaseYear : null,
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
  const artistRefs = getArtistRefs(item, searchJson);
  const artistIds = artistRefs.map((artist) => artist.id).filter(Boolean);
  return {
    verified: true,
    id: cleanText(item.id),
    query,
    title: cleanText(item.title || item.attributes?.title),
    version: cleanText(item.version || item.attributes?.version),
    artist: cleanText(artistRefs.map((artist) => artist.name).filter(Boolean).join(", ")),
    artists: artistRefs,
    artistIds,
    album: cleanText(album.title || album.attributes?.title),
    label: getLabel(item, album),
    year: getReleaseYear(item, album),
    releaseDate: getReleaseDate(item, album),
    releaseEvidence: getReleaseEvidence(item, album),
    durationMs: getDurationMs(item),
    isrc: getIsrc(item),
    imageUrl: getImageUrl(item, album, searchJson),
    tidalUrl: getTidalTrackUrl(item),
    mediaTags: getMediaTags(item),
    audioQuality: getAudioQuality(item),
    sampleRateKhz: getSampleRateKhz(item),
    bitDepth: getBitDepth(item),
    channels: getChannelCount(item),
    source: "tidal",
    sourceEvidence: [captureTidalEvidence(item, album, searchJson)]
  };
}

function withCatalogVersion(result) {
  const version = cleanText(result.version);
  if (!version || normalizeMatchText(result.title).includes(normalizeMatchText(version))) return result;
  return { ...result, title: `${result.title} (${version})` };
}

function candidateArtistIdentity(item = {}, searchJson = {}, artistContext = {}) {
  const candidateNames = getArtistNames(item, searchJson).map(normalizeMatchText).filter(Boolean);
  const candidateIds = new Set(getArtistIds(item, searchJson).map(cleanText).filter(Boolean));
  const requestedKey = artistContext.requestedKey;
  const requestedCreditKeys = artistContext.requestedCreditKeys || new Set([requestedKey]);
  const candidateCreditSetKey = artistCreditSetKey(candidateNames);
  const exact = Boolean(artistContext.requestedCreditSetKey && candidateCreditSetKey === artistContext.requestedCreditSetKey);
  const requestedDisplayKey = [...normalizeArtistCreditNames(artistContext.requested || "")].sort().join("|");
  const candidateDisplayKey = [...normalizeArtistCreditNames(candidateNames)].sort().join("|");
  const canonicalDisplayKey = [...(artistContext.canonicalArtistCredits || [])].sort().join("|");
  // A curated alias can compact to the same credit-set key as the request
  // (for example, GusGus vs Gus Gus). Preserve the exact matching behavior,
  // but expose that the trusted alias record supplied the equivalence.
  const canonicalAlias = Boolean(
    artistContext.matchedRecords?.length
      && canonicalDisplayKey
      && candidateDisplayKey === canonicalDisplayKey
      && requestedDisplayKey !== canonicalDisplayKey
  );
  const alias = canonicalAlias || (!exact && Boolean(
    artistContext.aliasCreditSetKeys?.has(candidateCreditSetKey)
      || candidateNames.some(name => artistContext.aliasKeys?.has(name))
      || [...candidateIds].some(id => artistContext.requestedIds?.has(id) || artistContext.mappedIds?.has(id))
  ));
  const partial = !exact && !alias && [...requestedCreditKeys].some(key => candidateNames.includes(key));
  return {
    names: candidateNames,
    ids: [...candidateIds],
    known: Boolean(candidateNames.length || candidateIds.size),
    exact,
    alias,
    partial,
    matched: !requestedKey || exact || alias || partial,
    candidateCreditSetKey,
    artistAliasApplied: alias,
    aliasSource: alias ? (artistContext.aliasSources?.join(", ") || "canonical-credit-alias") : "",
    artistCreditNormalizationRule: exact ? "canonical-credit-set" : alias ? "trusted-artist-alias" : ""
  };
}

function retrievalCandidateSummary(candidate = {}) {
  return {
    id: cleanText(candidate.id),
    artist: cleanText(candidate.artist),
    title: cleanText(candidate.title),
    album: cleanText(candidate.album),
    version: cleanText(candidate.version),
    year: candidate.candidateEra ?? candidate.year ?? null,
    retrievalScore: Number(candidate.retrievalScore || 0),
    preFilterAccepted: candidate.preFilterAccepted !== false,
    rejectionReason: candidate.rejectionReason || "",
    artistMatch: candidate.artistMatch || "",
    artistAliasApplied: Boolean(candidate.artistAliasApplied),
    aliasSource: candidate.aliasSource || "",
    canonicalArtistCredits: candidate.canonicalArtistCredits || [],
    artistCreditNormalizationRule: candidate.artistCreditNormalizationRule || "",
    providerIdentityEvidence: candidate.providerIdentityEvidence || null,
    expectedLegacyEra: candidate.expectedLegacyEra ?? null,
    expectedLegacyEraSource: candidate.expectedLegacyEraSource || "",
    candidateEra: candidate.candidateEra ?? candidate.year ?? null,
    candidateEraSource: candidate.candidateEraSource || "",
    eraDistanceYears: candidate.eraDistanceYears ?? null,
    eraSearchBoost: Number(candidate.eraSearchBoost || 0),
    modernReissuePenalty: Number(candidate.modernReissuePenalty || 0)
  };
}

function rankExactCatalogCandidates(track = {}, rawItems = [], searchJson = {}, {
  searchPlan = {},
  aliasRecords = []
} = {}) {
  const requested = parseCanonicalCatalogIdentity(track);
  const artistContext = artistLookupContext(track, aliasRecords);
  const requestedAlbum = normalizeAlbumFamily(typeof track.album === "object" ? track.album.title : track.album || track.releaseTitle || "");
  const suppliedEraEvidence = expectedLegacyEraEvidenceForTrack(track);
  let expectedLegacyEra = searchPlan.expectedLegacyEra || suppliedEraEvidence.year;
  let expectedLegacyEraSource = searchPlan.expectedLegacyEraSource || suppliedEraEvidence.source;
  const preparedItems = rawItems.map(item => ({
    item,
    result: item?.source === "tidal" && item.tidalUrl
      ? { ...item, query: item.query || searchPlan.candidateSourceQuery || searchPlan.query || "" }
      : buildResult(item, searchJson, searchPlan.candidateSourceQuery || searchPlan.query || "")
  }));
  if (expectedLegacyEra === null || expectedLegacyEra === undefined) {
    const inferredYears = preparedItems.map(({ item, result }) => {
      const candidate = parseCanonicalCatalogIdentity(result);
      const artist = candidateArtistIdentity(item, searchJson, artistContext);
      if (!artist.matched || candidate.normalizedBaseTitle !== requested.normalizedBaseTitle) return null;
      const evidence = result.releaseEvidence || {};
      const value = evidence.recordingYear || evidence.albumYear || result.year || evidence.isrcYear;
      const year = Number(value);
      return Number.isFinite(year) && year >= 1900 && year <= 2100
        ? { year, source: evidence.recordingYear ? "catalog-recording-year-inference" : evidence.albumYear ? "catalog-album-year-inference" : evidence.isrcYear ? "catalog-isrc-year-inference" : "catalog-release-year-inference" }
        : null;
    }).filter(Boolean).sort((left, right) => left.year - right.year);
    if (inferredYears.length) {
      expectedLegacyEra = inferredYears[0].year;
      expectedLegacyEraSource = inferredYears[0].source;
    }
  }
  const evaluated = [];
  for (const { item, result } of preparedItems) {
    const candidate = parseCanonicalCatalogIdentity(result);
    const artist = candidateArtistIdentity(item, searchJson, artistContext);
    const candidateAlbum = normalizeAlbumFamily(result.album || "");
    const candidateEra = result.releaseEvidence?.recordingYear
      || result.releaseEvidence?.albumYear
      || result.year
      || null;
    const candidateEraSource = result.releaseEvidence?.recordingYear ? "tidal-recording-year"
      : result.releaseEvidence?.albumYear ? "tidal-album-year"
        : result.year ? "catalog-release-year" : "";
    const eraDistanceYears = expectedLegacyEra && candidateEra ? Math.abs(Number(expectedLegacyEra) - Number(candidateEra)) : null;
    const baseTitleMatch = Boolean(requested.normalizedBaseTitle && candidate.normalizedBaseTitle === requested.normalizedBaseTitle);
    const fullTitleMatch = Boolean(requested.canonicalTitle && candidate.canonicalTitle === requested.canonicalTitle);
    const requestedVersion = requested.version;
    const candidateAlternateVersion = !requestedVersion.explicit && ["remix", "mixed", "dub", "orchestra", "alternate", "live", "acoustic", "remaster", "edit", "radio"].includes(candidate.versionKind);
    const explicitVersionMismatch = requestedVersion.explicit && candidate.versionKind !== requested.versionKind;
    const rejectionReasons = [];
    if (!result.title || !result.tidalUrl) rejectionReasons.push("incomplete-catalog-metadata");
    if (track.artist && artist.known && !artist.matched) rejectionReasons.push("no-artist-overlap-or-alias");
    if (!baseTitleMatch) rejectionReasons.push("incompatible-base-title");

    let retrievalScore = 0;
    if (fullTitleMatch) retrievalScore += 24;
    else if (baseTitleMatch) retrievalScore += 18;
    if (artist.exact) { retrievalScore += 100; }
    else if (artist.alias) { retrievalScore += 86; }
    else if (artist.partial) { retrievalScore += 82; }
    if (requestedAlbum) {
      if (candidateAlbum && candidateAlbum === requestedAlbum) retrievalScore += 36;
      else if (candidateAlbum) retrievalScore -= 8;
    }
    let eraSearchBoost = 0;
    let modernReissuePenalty = 0;
    if (eraDistanceYears !== null) {
      eraSearchBoost = eraDistanceYears <= 2 ? 24 : eraDistanceYears <= 5 ? 14 : eraDistanceYears <= 10 ? 5 : 0;
      retrievalScore += eraSearchBoost;
      if (eraDistanceYears > 15) modernReissuePenalty = Math.min(28, Math.round((eraDistanceYears - 15) * 1.5));
      retrievalScore -= modernReissuePenalty;
    }
    if (!requestedVersion.explicit && candidate.versionKind === "original") retrievalScore += 10;
    if (candidateAlternateVersion) {
      // Keep same-base alternate versions available so the identity resolver
      // can return VERSION_MISMATCH, but make canonical search prefer the
      // plain/original recording.
      retrievalScore -= 38;
    }
    if (explicitVersionMismatch) retrievalScore -= 42;
    if (searchPlan.titleOnlyFallback && track.artist && !artist.matched) rejectionReasons.push("title-only-no-artist-overlap");

    evaluated.push({
      ...result,
      retrievalScore,
      preFilterAccepted: rejectionReasons.length === 0,
      rejectionReason: rejectionReasons.join(","),
      artistMatch: artist.exact ? "exact" : artist.alias ? "alias" : artist.partial ? "partial" : artist.known ? (track.artist ? "none" : "unconstrained") : "unknown",
      artistAliasApplied: Boolean(artist.artistAliasApplied),
      aliasSource: artist.aliasSource || "",
      canonicalArtistCredits: artistContext.canonicalArtistCredits || [],
      artistCreditNormalizationRule: artist.artistCreditNormalizationRule || "",
      providerIdentityEvidence: {
        requestedArtistIds: [...(artistContext.requestedIds || [])],
        candidateArtistIds: artist.ids || [],
        matchedArtistIds: (artist.ids || []).filter(id => artistContext.requestedIds?.has(id) || artistContext.mappedIds?.has(id)),
        matchedBy: artist.exact ? "canonical-credit-set" : artist.alias ? (artist.aliasSource || "trusted-artist-alias") : artist.partial ? "credit-component-overlap" : ""
      },
      expectedLegacyEra,
      expectedLegacyEraSource,
      baseTitleMatch,
      candidateEra,
      candidateEraSource,
      eraDistanceYears,
      eraSearchBoost,
      modernReissuePenalty,
      explicitVersionMismatch,
      candidateAlternateVersion
    });
  }

  const accepted = evaluated.filter(candidate => candidate.preFilterAccepted)
    .sort((left, right) => right.retrievalScore - left.retrievalScore || String(left.id).localeCompare(String(right.id)));
  const rejected = evaluated.filter(candidate => !candidate.preFilterAccepted);
  const rejectionReasons = {};
  for (const candidate of rejected) {
    for (const reason of String(candidate.rejectionReason || "unknown").split(",")) rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
  }
  const retrieval = {
    searchStage: searchPlan.searchStage || "exact-artist-title",
    candidateSourceQuery: searchPlan.candidateSourceQuery || searchPlan.query || "",
    artistConstraintApplied: Boolean(searchPlan.artistConstraintApplied),
    titleConstraintApplied: Boolean(searchPlan.titleConstraintApplied),
    albumConstraintApplied: Boolean(searchPlan.albumConstraintApplied),
    eraConstraintApplied: Boolean(searchPlan.eraConstraintApplied),
    expectedLegacyEra: expectedLegacyEra || null,
    expectedLegacyEraSource,
    candidateEra: accepted[0]?.candidateEra ?? evaluated[0]?.candidateEra ?? null,
    candidateEraSource: accepted[0]?.candidateEraSource ?? evaluated[0]?.candidateEraSource ?? "",
    eraDistanceYears: accepted[0]?.eraDistanceYears ?? evaluated[0]?.eraDistanceYears ?? null,
    eraSearchBoost: accepted[0]?.eraSearchBoost ?? 0,
    modernReissuePenalty: accepted[0]?.modernReissuePenalty ?? 0,
    remixSuppressionApplied: evaluated.some(candidate => candidate.candidateAlternateVersion || candidate.explicitVersionMismatch),
    aliasLookupApplied: Boolean(artistContext.aliasLookupApplied),
    artistAliasApplied: Boolean(artistContext.aliasLookupApplied || evaluated.some(candidate => candidate.artistAliasApplied)),
    aliasSource: [...new Set([
      ...artistContext.aliasSources,
      ...evaluated.map(candidate => candidate.aliasSource).filter(Boolean)
    ])].join(", "),
    canonicalArtistIdentity: artistContext.canonicalArtistIdentity || "",
    canonicalArtistCredits: artistContext.canonicalArtistCredits || [],
    artistCreditNormalizationRule: evaluated.find(candidate => candidate.artistCreditNormalizationRule)?.artistCreditNormalizationRule || "",
    providerIdentityEvidence: evaluated.find(candidate => candidate.providerIdentityEvidence)?.providerIdentityEvidence || null,
    titleOnlyFallbackUsed: Boolean(searchPlan.titleOnlyFallback),
    candidatePreFilterCounts: {
      input: evaluated.length,
      accepted: accepted.length,
      rejected: rejected.length,
      rejectionReasons
    },
    topCandidatesBeforeFilter: [...evaluated].sort((left, right) => right.retrievalScore - left.retrievalScore).slice(0, 8).map(retrievalCandidateSummary),
    topCandidatesAfterFilter: accepted.slice(0, 8).map(retrievalCandidateSummary),
    reasonCorrectCandidateWasNotSelected: ""
  };
  return { candidates: accepted, evaluated, retrieval };
}

function emptyLegacySearchDiagnostics(track = {}) {
  const expectedLegacyEraEvidence = expectedLegacyEraEvidenceForTrack(track);
  return {
    searchStage: "",
    queriesAttempted: [],
    candidateCountPerQuery: [],
    artistConstraintApplied: Boolean(track.artist),
    titleConstraintApplied: Boolean(track.title),
    albumConstraintApplied: Boolean(track.album || track.releaseTitle),
    eraConstraintApplied: Boolean(expectedLegacyEraForTrack(track)),
    expectedLegacyEra: expectedLegacyEraEvidence.year,
    expectedLegacyEraSource: expectedLegacyEraEvidence.source,
    candidateEra: null,
    candidateEraSource: "",
    eraDistanceYears: null,
    eraSearchBoost: 0,
    modernReissuePenalty: 0,
    remixSuppressionApplied: false,
    aliasLookupApplied: Boolean(track.artistAliasApplied),
    artistAliasApplied: Boolean(track.artistAliasApplied),
    aliasSource: cleanText(track.artistAliasSource),
    canonicalArtistIdentity: cleanText(track.canonicalArtistIdentity),
    canonicalArtistCredits: Array.isArray(track.canonicalArtistCredits) ? track.canonicalArtistCredits : [],
    artistCreditNormalizationRule: "",
    providerIdentityEvidence: null,
    titleOnlyFallbackUsed: false,
    candidatePreFilterCounts: { input: 0, accepted: 0, rejected: 0, rejectionReasons: {} },
    topCandidatesBeforeFilter: [],
    topCandidatesAfterFilter: [],
    reasonCorrectCandidateWasNotSelected: ""
  };
}

function recordLegacySearchQuery(diagnostics, retrieval) {
  if (!diagnostics || !retrieval) return;
  diagnostics.searchStage = retrieval.searchStage || diagnostics.searchStage;
  diagnostics.artistConstraintApplied ||= Boolean(retrieval.artistConstraintApplied);
  diagnostics.titleConstraintApplied ||= Boolean(retrieval.titleConstraintApplied);
  diagnostics.albumConstraintApplied ||= Boolean(retrieval.albumConstraintApplied);
  diagnostics.eraConstraintApplied ||= Boolean(retrieval.eraConstraintApplied);
  diagnostics.expectedLegacyEra ||= retrieval.expectedLegacyEra || null;
  diagnostics.expectedLegacyEraSource ||= retrieval.expectedLegacyEraSource || "";
  diagnostics.candidateEra = retrieval.candidateEra ?? diagnostics.candidateEra;
  diagnostics.candidateEraSource ||= retrieval.candidateEraSource || "";
  diagnostics.eraDistanceYears = retrieval.eraDistanceYears ?? diagnostics.eraDistanceYears;
  diagnostics.eraSearchBoost = Math.max(diagnostics.eraSearchBoost || 0, retrieval.eraSearchBoost || 0);
  diagnostics.modernReissuePenalty = Math.max(diagnostics.modernReissuePenalty || 0, retrieval.modernReissuePenalty || 0);
  diagnostics.remixSuppressionApplied ||= Boolean(retrieval.remixSuppressionApplied);
  diagnostics.aliasLookupApplied ||= Boolean(retrieval.aliasLookupApplied);
  diagnostics.artistAliasApplied ||= Boolean(retrieval.artistAliasApplied);
  diagnostics.aliasSource ||= retrieval.aliasSource || "";
  diagnostics.canonicalArtistIdentity ||= retrieval.canonicalArtistIdentity || "";
  if (!diagnostics.canonicalArtistCredits?.length && retrieval.canonicalArtistCredits?.length) diagnostics.canonicalArtistCredits = retrieval.canonicalArtistCredits;
  diagnostics.artistCreditNormalizationRule ||= retrieval.artistCreditNormalizationRule || "";
  diagnostics.providerIdentityEvidence ||= retrieval.providerIdentityEvidence || null;
  diagnostics.titleOnlyFallbackUsed ||= Boolean(retrieval.titleOnlyFallbackUsed);
  const counts = retrieval.candidatePreFilterCounts || {};
  diagnostics.candidatePreFilterCounts.input += Number(counts.input || 0);
  diagnostics.candidatePreFilterCounts.accepted += Number(counts.accepted || 0);
  diagnostics.candidatePreFilterCounts.rejected += Number(counts.rejected || 0);
  for (const [reason, count] of Object.entries(counts.rejectionReasons || {})) {
    diagnostics.candidatePreFilterCounts.rejectionReasons[reason] = (diagnostics.candidatePreFilterCounts.rejectionReasons[reason] || 0) + Number(count || 0);
  }
  const queryRecord = {
    searchStage: retrieval.searchStage,
    candidateSourceQuery: retrieval.candidateSourceQuery,
    artistConstraintApplied: Boolean(retrieval.artistConstraintApplied),
    titleConstraintApplied: Boolean(retrieval.titleConstraintApplied),
    albumConstraintApplied: Boolean(retrieval.albumConstraintApplied),
    eraConstraintApplied: Boolean(retrieval.eraConstraintApplied),
    expectedLegacyEra: retrieval.expectedLegacyEra ?? null,
    expectedLegacyEraSource: retrieval.expectedLegacyEraSource || "",
    candidateEra: retrieval.candidateEra ?? null,
    candidateEraSource: retrieval.candidateEraSource || "",
    titleOnlyFallbackUsed: Boolean(retrieval.titleOnlyFallbackUsed),
    artistAliasApplied: Boolean(retrieval.artistAliasApplied),
    aliasSource: retrieval.aliasSource || "",
    canonicalArtistIdentity: retrieval.canonicalArtistIdentity || "",
    canonicalArtistCredits: retrieval.canonicalArtistCredits || [],
    artistCreditNormalizationRule: retrieval.artistCreditNormalizationRule || "",
    providerIdentityEvidence: retrieval.providerIdentityEvidence || null,
    returnedCount: Number(counts.input || 0),
    acceptedCount: Number(counts.accepted || 0),
    rejectedCount: Number(counts.rejected || 0),
    candidatePreFilterCounts: counts,
    topCandidatesBeforeFilter: retrieval.topCandidatesBeforeFilter || [],
    topCandidatesAfterFilter: retrieval.topCandidatesAfterFilter || []
  };
  diagnostics.queriesAttempted.push(queryRecord);
  diagnostics.candidateCountPerQuery.push({
    query: retrieval.candidateSourceQuery,
    searchStage: retrieval.searchStage,
    returned: Number(counts.input || 0),
    accepted: Number(counts.accepted || 0),
    rejected: Number(counts.rejected || 0)
  });
  const mergeCandidates = (field) => {
    const merged = [...(diagnostics[field] || []), ...(retrieval[field] || [])];
    diagnostics[field] = [...new Map(merged.map(candidate => [candidate.id || `${candidate.artist}|${candidate.title}|${candidate.album}`, candidate])).values()]
      .sort((left, right) => Number(right.retrievalScore || 0) - Number(left.retrievalScore || 0))
      .slice(0, 12);
  };
  mergeCandidates("topCandidatesBeforeFilter");
  mergeCandidates("topCandidatesAfterFilter");
}

function finalizeLegacySearchDiagnostics(diagnostics, { selected = false } = {}) {
  if (!diagnostics) return diagnostics;
  if (selected) diagnostics.reasonCorrectCandidateWasNotSelected = "";
  else if (!diagnostics.candidatePreFilterCounts.accepted) diagnostics.reasonCorrectCandidateWasNotSelected = "all returned rows failed the artist/title pre-filter";
  else diagnostics.reasonCorrectCandidateWasNotSelected = "retrieved candidates survived pre-filtering but none passed exact identity validation";
  return diagnostics;
}

function resultFromCandidate(candidate, searchJson, query, requestedTrack = {}) {
  if (!candidate?.entry) return null;
  const entry = candidate.entry;
  const result = entry.source === "tidal" && entry.tidalUrl
    ? { ...entry, query: entry.query || query }
    : buildResult(entry, searchJson, query);
  const identity = scoreTidalIdentity(requestedTrack, result);
  return {
    ...result,
    matchScore: candidate.score,
    identityOutcome: identity.outcome,
    identityConfidence: identity.confidenceScore,
    identityDiagnostics: identity
  };
}

function exactTrackSearchQueries(track = {}) {
  return buildExactSearchPlans(track, { strict: false }).map(plan => plan.query);
}

function canonicalFallbackPlans(track = {}) {
  const parsed = parseCanonicalCatalogIdentity(track);
  const base = cleanText(parsed.normalizedBaseTitle);
  const artist = cleanText(track.artist || "");
  const album = cleanText(track.album || track.releaseTitle || "");
  const year = String(track.recordingYear || track.originalReleaseYear || track.year || "").match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
  const plans = [
    ["normalized-base-title", base || parsed.normalizedBaseTitle],
    ["primary-artist-base-title", `${artist} ${base || parsed.normalizedBaseTitle}`],
    ["artist-album-base-title", album ? `${artist} ${album} ${base || parsed.normalizedBaseTitle}` : ""],
    ["original-era-base-title", year ? `${artist} ${base || parsed.normalizedBaseTitle} ${year}` : ""]
  ];
  return Array.from(new Map(plans
    .map(([label, query]) => [label, normalizeExactSearchQuery(query)])
    .filter(([, query]) => query)
    .map(([label, query]) => [query, { label, query }])).values());
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
    this.profileAccessTokenProvider = typeof config.profileAccessTokenProvider === "function" ? config.profileAccessTokenProvider : null;
    this.profileAccessToken = "";
    this.profileAccessTokenRejected = false;
    this.useProfileAccessToken = false;
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
    this.exactIdentityDiagnosticsCache = new Map();
    this.lastExactIdentityDiagnostics = null;
    this.catalogCache = new Map();
    this.catalogProgress = new TidalCatalogProgressStore({
      file: config.catalogPaginationFile || config.catalogProgressFile || DEFAULT_TIDAL_CATALOG_PAGINATION_FILE,
      clock: this.clock
    });
    this.catalogProgressLocks = new Map();
    this.artistAliasFile = config.artistAliasFile || DEFAULT_TIDAL_ARTIST_ALIAS_FILE;
    this.artistAliasRecords = loadArtistAliasRecords(
      config.artistAliases || config.artistAliasMap || config.identityArtistAliases,
      this.artistAliasFile
    );
    this.validatedIdentityLookup = typeof config.validatedIdentityLookup === "function" ? config.validatedIdentityLookup : null;
    this.lastValidatedIdentityLookup = null;
    this.lastValidatedIdentityReuseDiagnostics = null;
    this.sleep = typeof config.sleep === "function" ? config.sleep : sleep;
    this.nextRequestAt = 0;
    this.identityDisambiguation = normalizeDisambiguationOptions({
      highConfidenceThreshold: config.identityHighConfidenceThreshold ?? IDENTITY_DISAMBIGUATION_DEFAULTS.highConfidenceThreshold,
      minimumConfidenceMargin: config.identityConfidenceMargin ?? IDENTITY_DISAMBIGUATION_DEFAULTS.minimumConfidenceMargin,
      alternateVersionThreshold: config.identityAlternateVersionThreshold ?? IDENTITY_DISAMBIGUATION_DEFAULTS.alternateVersionThreshold,
      legacyEraGapYears: config.identityLegacyEraGapYears ?? IDENTITY_DISAMBIGUATION_DEFAULTS.legacyEraGapYears,
      legacyOriginalYearCutoff: config.identityLegacyOriginalYearCutoff ?? IDENTITY_DISAMBIGUATION_DEFAULTS.legacyOriginalYearCutoff,
      legacyPreferenceMargin: config.identityLegacyPreferenceMargin ?? IDENTITY_DISAMBIGUATION_DEFAULTS.legacyPreferenceMargin
    });
  }

  isConfigured() {
    return Boolean(this.enabled && (this.accessToken || (this.clientId && this.clientSecret) || this.profileAccessTokenProvider));
  }

  setValidatedIdentityLookup(lookup) {
    this.validatedIdentityLookup = typeof lookup === "function" ? lookup : null;
    return this;
  }

  async validatedIdentityCandidates(track = {}) {
    this.lastValidatedIdentityLookup = null;
    if (!this.validatedIdentityLookup) return [];
    const context = artistLookupContext(track, this.artistAliasRecords);
    const lookupArtists = [...new Map([
      cleanText(track.artist),
      context.canonicalArtistIdentity,
      ...context.aliases
    ].map(value => [normalizeMatchText(value), cleanText(value)])
      .filter(([key, value]) => key && value)).values()];
    const attempts = [];
    const errors = [];
    const byIdentity = new Map();

    for (const artist of lookupArtists.length ? lookupArtists : [cleanText(track.artist)]) {
      const lookupTrack = {
        ...track,
        artist,
        canonicalArtistIdentity: context.canonicalArtistIdentity,
        artistAliases: context.aliases
      };
      try {
        const result = await this.validatedIdentityLookup(lookupTrack);
        const candidates = Array.isArray(result) ? result : result?.candidates;
        const normalized = (Array.isArray(candidates) ? candidates : [])
          .filter(candidate => candidate && (candidate.tidalId || candidate.tidalTrackId || candidate.tidalUrl || candidate.id));
        attempts.push({
          artist,
          candidateCount: normalized.length,
          source: cleanText(Array.isArray(result) ? "" : result?.source) || "validated-identity-lookup"
        });
        for (const candidate of normalized) {
          const id = cleanText(candidate.tidalId || candidate.tidalTrackId || candidate.id || getTrackIdFromUrl(candidate.tidalUrl));
          const key = id || `${normalizeMatchText(candidate.artist)}|${normalizeMatchText(candidate.title)}`;
          const previous = byIdentity.get(key);
          byIdentity.set(key, previous ? {
            ...previous,
            validatedIdentityLookupArtists: [...new Set([
              ...(previous.validatedIdentityLookupArtists || []),
              artist
            ])]
          } : {
            ...candidate,
            validatedIdentityLookupArtists: [artist]
          });
        }
      } catch (error) {
        const message = cleanText(error.message);
        attempts.push({ artist, candidateCount: 0, source: "validated-identity-lookup", error: message });
        errors.push({ artist, error: message });
      }
    }
    const normalized = [...byIdentity.values()];
    this.lastValidatedIdentityLookup = {
      attempted: true,
      candidateCount: normalized.length,
      source: attempts.map(attempt => attempt.source).find(Boolean) || "validated-identity-lookup",
      requestedArtist: cleanText(track.artist),
      canonicalArtistIdentity: context.canonicalArtistIdentity,
      normalizedBaseTitle: parseCanonicalCatalogIdentity(track).normalizedBaseTitle,
      aliasLookupAttempted: lookupArtists.some(artist => normalizeMatchText(artist) !== context.requestedKey),
      aliasLookupArtists: lookupArtists,
      candidateCountsByArtist: attempts,
      errors
    };
    return normalized;
  }

  validatedIdentityVersionEligibility(requested = {}, candidate = {}, options = {}, peers = []) {
    const requestedIdentity = parseCanonicalCatalogIdentity(requested);
    const candidateIdentity = parseCanonicalCatalogIdentity(candidate);
    if (requestedIdentity.version.explicit) {
      return { allowed: false, reason: "explicit-request-version-not-reused" };
    }
    const principalRelease = canonicalTwelveInchClubEvidence(requested, candidate, peers, options);
    if (principalRelease.applied) {
      return {
        allowed: true,
        reason: "canonical-12-inch-club-principal",
        canonicalPrincipalReleaseEvidence: principalRelease
      };
    }
    if (!candidateIdentity.version.explicit || candidateIdentity.version.kind === "original") {
      return { allowed: true, reason: "canonical-plain-or-original" };
    }
    if (["main mix", "main version"].includes(candidateIdentity.version.normalized)) {
      return { allowed: true, reason: "canonical-main-mix" };
    }
    return {
      allowed: false,
      reason: "named-alternate-version-not-reused",
      candidateVersion: candidateIdentity.version.normalized || candidateIdentity.version.label || ""
    };
  }

  async revalidateValidatedIdentityCandidates(track = {}, candidates = {}) {
    const requestedTrack = this.requestedTrackForIdentity(track);
    const valid = [];
    const diagnostics = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const storedId = cleanText(candidate.tidalId || candidate.tidalTrackId || candidate.id || getTrackIdFromUrl(candidate.tidalUrl));
      const diagnostic = {
        id: storedId,
        storedArtist: cleanText(candidate.artist),
        storedTitle: cleanText(candidate.title),
        revalidated: false,
        revalidationReason: ""
      };
      if (!/^\d+$/.test(storedId)) {
        diagnostic.revalidationReason = "invalid-stored-tidal-id";
        diagnostics.push(diagnostic);
        continue;
      }

      let fresh = null;
      try {
        fresh = await this.getTrack(storedId, `${track.artist || ""} ${track.title || ""}`.trim());
      } catch {
        fresh = null;
      }
      if (!fresh || (fresh.id && cleanText(fresh.id) !== storedId)) {
        diagnostic.revalidationReason = "tidal-id-revalidation-failed";
        diagnostics.push(diagnostic);
        continue;
      }

      const providerVersion = cleanText(fresh.version || fresh.mixVersion || fresh.mixName || fresh.remix);
      const storedVersion = cleanText(candidate.version || candidate.mixVersion || candidate.mixName || candidate.remix);
      const refreshed = {
        ...candidate,
        ...fresh,
        id: storedId,
        tidalId: cleanText(candidate.tidalId) || storedId,
        tidalTrackId: cleanText(candidate.tidalTrackId) || storedId,
        tidalUrl: fresh.tidalUrl || candidate.tidalUrl || `https://tidal.com/browse/track/${storedId}`,
        version: providerVersion || storedVersion,
        mixVersion: providerVersion || cleanText(candidate.mixVersion) || storedVersion,
        mixName: cleanText(fresh.mixName) || cleanText(candidate.mixName) || storedVersion,
        validatedIdentityRevalidated: true
      };
      const evidence = scoreTidalIdentity(requestedTrack, refreshed);
      diagnostic.revalidated = true;
      diagnostic.revalidatedArtist = cleanText(refreshed.artist);
      diagnostic.revalidatedTitle = cleanText(refreshed.title);
      diagnostic.revalidatedVersion = parseCanonicalCatalogIdentity(refreshed).version;
      diagnostic.normalizedBaseTitleMatch = Boolean(evidence.normalizedBaseTitleMatch);
      diagnostic.artistMatched = Boolean(evidence.artistRelation?.matched);
      diagnostic.artistAliasApplied = Boolean(evidence.artistRelation?.artistAliasApplied);
      diagnostic.aliasSource = evidence.artistRelation?.aliasSource || "";
      if (!evidence.normalizedBaseTitleMatch) diagnostic.revalidationReason = "revalidated-base-title-incompatible";
      else if (!evidence.artistRelation?.matched) diagnostic.revalidationReason = "revalidated-artist-incompatible";
      else diagnostic.revalidationReason = "tidal-id-revalidated-compatible";
      diagnostics.push(diagnostic);
      if (evidence.normalizedBaseTitleMatch && evidence.artistRelation?.matched) {
        valid.push({
          ...refreshed,
          validatedIdentityRevalidation: diagnostic
        });
      }
    }
    return { candidates: valid, diagnostics };
  }

  async findValidatedIdentity(track = {}, options = {}) {
    const storedCandidates = await this.validatedIdentityCandidates(track);
    const revalidated = await this.revalidateValidatedIdentityCandidates(track, storedCandidates);
    const candidates = revalidated.candidates;
    this.lastValidatedIdentityReuseDiagnostics = {
      attempted: Boolean(this.validatedIdentityLookup),
      candidateCount: storedCandidates.length,
      revalidatedCandidateCount: candidates.length,
      lookup: this.lastValidatedIdentityLookup,
      requested: { artist: cleanText(track.artist), title: cleanText(track.title) },
      normalizedBaseTitle: parseCanonicalCatalogIdentity(track).normalizedBaseTitle,
      canonicalArtistIdentity: artistLookupContext(track, this.artistAliasRecords).canonicalArtistIdentity,
      candidates: revalidated.diagnostics,
      accepted: false,
      rejectionReason: candidates.length ? "no-eligible-validated-identity" : storedCandidates.length ? "no-compatible-revalidated-identity" : "no-validated-identity-candidates"
    };
    if (!candidates.length) return null;
    const identityTrack = this.requestedTrackForIdentity({ ...track, validatedIdentity: candidates[0] });
    const evaluatedCandidates = candidates.map(candidate => ({
      candidate,
      evidence: scoreTidalIdentity(identityTrack, candidate),
      versionEligibility: this.validatedIdentityVersionEligibility(track, candidate, options, candidates)
    }));
    const candidateDiagnostics = evaluatedCandidates.map(({ candidate, evidence, versionEligibility }) => ({
      id: cleanText(candidate.id || candidate.tidalId),
      artist: cleanText(candidate.artist),
      title: cleanText(candidate.title),
      version: parseCanonicalCatalogIdentity(candidate).version,
      normalizedBaseTitleMatch: Boolean(evidence.normalizedBaseTitleMatch),
      artistMatched: Boolean(evidence.artistRelation?.matched),
      artistAliasApplied: Boolean(evidence.artistRelation?.artistAliasApplied),
      aliasSource: evidence.artistRelation?.aliasSource || "",
      versionAllowed: versionEligibility.allowed,
      versionReason: versionEligibility.reason,
      confidenceScore: evidence.confidenceScore,
      revalidation: candidate.validatedIdentityRevalidation || null
    }));
    const selection = chooseExact(identityTrack, candidates, options);
    const selectionEligibility = selection?.match
      ? this.validatedIdentityVersionEligibility(track, selection.match, options, candidates)
      : null;
    if (selection?.match && selectionEligibility?.allowed) {
      const eraEvidence = expectedLegacyEraEvidenceForTrack({ ...track, validatedIdentity: selection.match });
      this.lastValidatedIdentityReuseDiagnostics = {
        ...this.lastValidatedIdentityReuseDiagnostics,
         accepted: true,
         acceptedId: cleanText(selection.match.id || selection.match.tidalId),
         acceptedReason: selectionEligibility.reason,
          candidates: candidateDiagnostics.map(candidate => ({
            ...candidate,
            allowed: candidate.id === cleanText(selection.match.id || selection.match.tidalId)
              ? true : candidate.versionAllowed,
            reason: candidate.id === cleanText(selection.match.id || selection.match.tidalId)
              ? selectionEligibility.reason : candidate.versionReason
          }))
        };
      return {
        ...selection,
        expectedLegacyEra: eraEvidence.year,
        expectedLegacyEraSource: eraEvidence.source,
        validatedIdentityReuse: true,
        validatedIdentitySource: selection.match.validatedIdentitySource || "validated-identity-lookup",
        validatedIdentityCandidates: candidates,
        validatedIdentityReuseDiagnostics: this.lastValidatedIdentityReuseDiagnostics
      };
    }

    // A stored validated TIDAL identity may carry a provider version suffix
    // (for example, Main Mix) while the supplied legacy request is unversioned.
    // Reuse is allowed only for an existing TIDAL id, the same canonical base
    // title, a non-conflicting artist relation, and no explicit requested
    // version. This does not alter search thresholds or Beatport safety.
    const requestedVersion = parseCanonicalCatalogIdentity(identityTrack).version;
    if (requestedVersion.explicit) {
      this.lastValidatedIdentityReuseDiagnostics.rejectionReason = "explicit-request-version-not-reused";
      return null;
    }
    this.lastValidatedIdentityReuseDiagnostics.candidates = candidateDiagnostics;
    const reusable = evaluatedCandidates.filter(({ candidate, evidence, versionEligibility }) => versionEligibility.allowed
      && evidence.normalizedBaseTitleMatch
      && evidence.artistRelation?.matched
      && evidence.isrcMatch !== false
      && evidence.tidalIdMatch !== false)
      .sort((left, right) => right.evidence.confidenceScore - left.evidence.confidenceScore)[0];
    if (!reusable) return null;
    const priorArtistRelation = reusable.evidence.artistRelation?.matched
      ? reusable.evidence.artistRelation
      : {
        ...reusable.evidence.artistRelation,
        matched: true,
        type: "validated-identity-artist-alias",
        artistAliasApplied: true,
        aliasSource: "validated-identity-store"
      };
    const priorEvidence = {
      ...reusable.evidence,
      artistRelation: priorArtistRelation,
      artistAliasApplied: Boolean(priorArtistRelation.artistAliasApplied),
      aliasSource: priorArtistRelation.aliasSource || "",
      outcome: "VERIFIED_VALIDATED_IDENTITY_REUSE",
      rejectionReason: "",
      legacyIdentityDiagnostics: {
        ...(reusable.evidence.legacyIdentityDiagnostics || {}),
        artistAliasApplied: Boolean(priorArtistRelation.artistAliasApplied),
        aliasSource: priorArtistRelation.aliasSource || "",
        canonicalArtistCredits: reusable.evidence.canonicalArtistCredits || []
      }
    };
    this.lastValidatedIdentityReuseDiagnostics = {
      ...this.lastValidatedIdentityReuseDiagnostics,
      accepted: true,
      acceptedId: cleanText(reusable.candidate.id || reusable.candidate.tidalId),
       acceptedReason: reusable.versionEligibility.reason,
       acceptedRevalidation: reusable.candidate.validatedIdentityRevalidation || null
    };
    return {
      status: "VERIFIED_TIDAL_ONLY",
      identityOutcome: "VERIFIED_VALIDATED_IDENTITY_REUSE",
      finalIdentityOutcome: "VERIFIED_VALIDATED_IDENTITY_REUSE",
      match: reusable.candidate,
      confidenceScore: reusable.evidence.confidenceScore,
      expectedLegacyEra: expectedLegacyEraEvidenceForTrack({ ...track, validatedIdentity: reusable.candidate }).year,
      expectedLegacyEraSource: expectedLegacyEraEvidenceForTrack({ ...track, validatedIdentity: reusable.candidate }).source,
      identityDiagnostics: {
        ...priorEvidence,
        validatedIdentityReuse: true,
        validatedIdentitySource: reusable.candidate.validatedIdentitySource || "validated-identity-lookup"
      },
      candidateIdentities: [{
        id: cleanText(reusable.candidate.id || reusable.candidate.tidalId),
        artist: cleanText(reusable.candidate.artist),
        title: cleanText(reusable.candidate.title),
        identityOutcome: "VERIFIED_VALIDATED_IDENTITY_REUSE",
        confidenceScore: reusable.evidence.confidenceScore,
        validatedIdentityReuse: true,
        validatedIdentitySource: reusable.candidate.validatedIdentitySource || "validated-identity-lookup",
        identityDiagnostics: {
          requestedArtistCredits: priorArtistRelation.requestedCredits || [],
          candidateArtistCredits: priorArtistRelation.candidateCredits || [],
          artistOverlapType: priorArtistRelation.type || "",
          artistAliasApplied: Boolean(priorArtistRelation.artistAliasApplied),
          aliasSource: priorArtistRelation.aliasSource || "",
          canonicalArtistCredits: priorEvidence.canonicalArtistCredits || [],
          normalizedBaseTitleMatch: priorEvidence.normalizedBaseTitleMatch,
          candidateConfidenceScore: priorEvidence.confidenceScore,
          legacyIdentityDiagnostics: priorEvidence.legacyIdentityDiagnostics || null
        },
        legacyIdentityDiagnostics: priorEvidence.legacyIdentityDiagnostics || null
      }],
      validatedIdentityReuse: true,
      validatedIdentitySource: reusable.candidate.validatedIdentitySource || "validated-identity-lookup",
      validatedIdentityCandidates: candidates,
      validatedIdentityReuseDiagnostics: this.lastValidatedIdentityReuseDiagnostics
    };
  }

  status() {
    return {
      enabled: this.enabled,
      configured: this.isConfigured(),
      timeoutMs: this.timeoutMs,
      profileTokenFallbackConfigured: Boolean(this.profileAccessTokenProvider),
      usingProfileTokenFallback: Boolean(this.useProfileAccessToken),
      catalogPagination: {
        enabled: true,
        entries: this.catalogProgress.size(),
        file: this.catalogProgress.file
      },
      artistAliases: {
        configured: this.artistAliasRecords.length,
        file: this.artistAliasFile
      },
      identityDisambiguation: { ...this.identityDisambiguation },
      circuit: this.circuitBreaker.status()
    };
  }

  catalogProgressKey(source, anchor) {
    return `${cleanText(source) || "catalog"}:${this.countryCode}:${normalizeMatchText(anchor)}`;
  }

  catalogProgressStateFor(key, source, anchor) {
    const existing = this.catalogProgress.get(key);
    if (existing) return existing;
    return {
      source: cleanText(source),
      anchor: cleanText(anchor),
      next: null,
      exhausted: false,
      seenRows: [],
      lastRequested: null,
      lastNext: null
    };
  }

  exactSearchPlans(track = {}, { strict = false } = {}) {
    return buildExactSearchPlans(track, { strict, aliasRecords: this.artistAliasRecords });
  }

  requestedTrackForIdentity(track = {}) {
    const context = artistLookupContext(track, this.artistAliasRecords);
    const aliases = context.aliases.filter(alias => normalizeMatchText(alias) !== context.requestedKey);
    return {
      ...track,
      artistAliases: aliases,
      artistAliasKeys: aliases.map(normalizeMatchText).filter(Boolean),
      canonicalArtistIdentity: context.canonicalArtistIdentity,
      artistAliasApplied: context.aliasLookupApplied,
      artistAliasSource: context.aliasSources.join(", ")
    };
  }

  prepareExactCandidates(track, rawItems, searchJson, searchPlan = {}) {
    return rankExactCatalogCandidates(this.requestedTrackForIdentity(track), rawItems, searchJson, {
      searchPlan,
      aliasRecords: this.artistAliasRecords
    });
  }

  async withCatalogProgressLock(key, operation) {
    const previous = this.catalogProgressLocks.get(key) || Promise.resolve();
    const current = previous.then(operation, operation);
    this.catalogProgressLocks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.catalogProgressLocks.get(key) === current) this.catalogProgressLocks.delete(key);
    }
  }

  reportCatalogPagination(callback, info) {
    if (typeof callback !== "function") return;
    try {
      callback(info);
    } catch {
      // Diagnostics must never change catalog availability or queue behavior.
    }
  }

  async fetchCatalogPage({
    source,
    anchor,
    baseUrl,
    requestOptions = {},
    rotate = false,
    cacheVariant = "",
    relationshipNames = [],
    getPageItems,
    mapItems,
    onPagination
  } = {}) {
    const normalizedSource = cleanText(source) || "catalog";
    const normalizedAnchor = cleanText(anchor);
    const progressKey = this.catalogProgressKey(normalizedSource, normalizedAnchor);
    const operation = async () => {
      let progress = rotate ? this.catalogProgressStateFor(progressKey, normalizedSource, normalizedAnchor) : {
        source: normalizedSource,
        anchor: normalizedAnchor,
        next: null,
        exhausted: false,
        seenRows: []
      };
      if (rotate && progress.exhausted) {
        progress = {
          ...progress,
          next: null,
          exhausted: false,
          seenRows: [],
          lastRequested: null,
          lastNext: null
        };
        this.catalogProgress.set(progressKey, progress);
      }

      const requestUrl = progress.next?.url
        ? normalizeCatalogPaginationUrl(progress.next.url, baseUrl)
        : new URL(baseUrl).toString();
      const requested = paginationDescriptorForUrl(requestUrl, baseUrl);
      const progressResumed = Boolean(rotate && progress.next);
      const cacheKey = [
        "catalog-page",
        normalizedSource,
        this.countryCode,
        normalizeMatchText(normalizedAnchor),
        cacheVariant,
        rotate ? "rotate" : "first",
        paginationRequestKey(requested)
      ].join(":");
      const cached = this.catalogCache.get(cacheKey);
      if (cached) {
        if (rotate) this.catalogProgress.set(progressKey, cached.nextProgress);
        this.reportCatalogPagination(onPagination, {
          ...cached.pagination,
          cacheHit: true,
          progressResumed
        });
        return cached.items;
      }

      let searchJson;
      let actualUrl = requestUrl;
      let cursorRecovery = false;
      try {
        searchJson = await this.fetchTidalJson(requestUrl);
      } catch (error) {
        const invalidProgress = progressResumed && [400, 404].includes(Number(error?.status || 0));
        if (!invalidProgress) {
          this.reportCatalogPagination(onPagination, {
            source: normalizedSource,
            anchor: normalizedAnchor,
            query: normalizedAnchor,
            requestedCursor: requested.cursor || null,
            requestedPage: requested.kind === "page" ? requested.page : null,
            requestedOffset: requested.kind === "offset" ? requested.offset : null,
            nextCursor: null,
            nextPage: null,
            nextOffset: null,
            returnedCount: 0,
            duplicateCount: 0,
            acceptedCount: 0,
            rejectedCount: 0,
            budgetCost: 1,
            progressResumed,
            error: cleanText(error?.message || error)
          });
          throw error;
        }
        cursorRecovery = true;
        progress = {
          ...progress,
          next: null,
          exhausted: false,
          seenRows: [],
          lastRequested: null,
          lastNext: null
        };
        this.catalogProgress.set(progressKey, progress);
        actualUrl = new URL(baseUrl).toString();
        searchJson = await this.fetchTidalJson(actualUrl);
      }

      if (searchJson === null && progressResumed) {
        cursorRecovery = true;
        progress = {
          ...progress,
          next: null,
          exhausted: false,
          seenRows: [],
          lastRequested: null,
          lastNext: null
        };
        this.catalogProgress.set(progressKey, progress);
        actualUrl = new URL(baseUrl).toString();
        searchJson = await this.fetchTidalJson(actualUrl);
      }

      const rawItems = typeof getPageItems === "function" ? getPageItems(searchJson || {}) : [];
      const seenRows = new Set(rotate ? progress.seenRows : []);
      const pageRows = new Set();
      const uniqueItems = [];
      let duplicateCount = 0;
      for (const item of rawItems) {
        const rowKey = catalogItemIdentity(item, searchJson || {});
        if (rowKey && (seenRows.has(rowKey) || pageRows.has(rowKey))) {
          duplicateCount += 1;
          continue;
        }
        if (rowKey) pageRows.add(rowKey);
        uniqueItems.push(item);
      }

      const items = typeof mapItems === "function" ? await mapItems(uniqueItems, searchJson || {}) : uniqueItems;
      const next = nextPaginationFrom(searchJson || {}, actualUrl, { relationshipNames });
      const nextProgress = {
        ...progress,
        source: normalizedSource,
        anchor: normalizedAnchor,
        next: next ? {
          kind: next.kind,
          url: next.url,
          cursor: next.cursor || "",
          page: next.page ?? null,
          offset: next.offset ?? null
        } : null,
        exhausted: !next,
        seenRows: rotate
          ? [...new Set([...progress.seenRows, ...pageRows])].slice(-5000)
          : [],
        lastRequested: {
          kind: requested.kind,
          cursor: requested.cursor || "",
          page: requested.page ?? null,
          offset: requested.offset ?? null,
          url: requestUrl
        },
        lastNext: next ? {
          kind: next.kind,
          cursor: next.cursor || "",
          page: next.page ?? null,
          offset: next.offset ?? null,
          url: next.url
        } : null
      };
      if (rotate) this.catalogProgress.set(progressKey, nextProgress);

      const pagination = {
        source: normalizedSource,
        anchor: normalizedAnchor,
        query: normalizedAnchor,
        requestedCursor: requested.cursor || null,
        requestedPage: requested.kind === "page" ? requested.page : null,
        requestedOffset: requested.kind === "offset" ? requested.offset : null,
        nextCursor: next?.cursor || null,
        nextPage: next?.page ?? null,
        nextOffset: next?.offset ?? null,
        returnedCount: rawItems.length,
        duplicateCount,
        acceptedCount: items.length,
        rejectedCount: Math.max(0, rawItems.length - duplicateCount - items.length),
        budgetCost: 1,
        progressResumed,
        cursorRecovery,
        exhausted: !next
      };
      this.catalogCache.set(cacheKey, { items, nextProgress, pagination });
      this.reportCatalogPagination(onPagination, pagination);
      return items;
    };

    return rotate ? this.withCatalogProgressLock(progressKey, operation) : operation();
  }

  async fetchCatalogPages({ pageCount = 1, ...config } = {}) {
    const requestedPageCount = Number(pageCount || 1);
    const normalizedPageCount = Number.isFinite(requestedPageCount)
      ? Math.max(1, Math.min(4, Math.floor(requestedPageCount)))
      : 1;
    if (normalizedPageCount === 1) return this.fetchCatalogPage(config);

    // Multi-page crawls are an explicit under-fill recovery path. They must
    // use the resumable catalog cursor so each page advances the same anchor
    // and the existing progress store remains the source of truth.
    const originalOnPagination = config.onPagination;
    const pages = [];
    let lastPagination = null;
    for (let index = 0; index < normalizedPageCount; index += 1) {
      const page = await this.fetchCatalogPage({
        ...config,
        rotate: true,
        onPagination: info => {
          lastPagination = info;
          this.reportCatalogPagination(originalOnPagination, info);
        }
      });
      pages.push(...page);
      if (lastPagination && lastPagination.exhausted) break;
      if (lastPagination && !lastPagination.nextCursor && !lastPagination.nextPage && !lastPagination.nextOffset) break;
    }
    return pages;
  }

  async findExactTrack(track, { strict = false, limit = 6, includePageYear = false, maxQueries = 6 } = {}, attempt = 0) {
    this.lastExactIdentityDiagnostics = null;
    if (!this.isConfigured()) return null;
    const validatedIdentityCandidates = await this.validatedIdentityCandidates(track);
    const searchTrack = validatedIdentityCandidates.length
      ? { ...track, validatedIdentity: validatedIdentityCandidates[0] }
      : track;
    const searchPlans = this.exactSearchPlans(searchTrack, { strict });
    const plans = searchPlans.slice(0, Math.max(1, Math.min(12, Number(maxQueries || 6))));
    const queries = plans.map(plan => plan.query);
    if (!plans.length) return null;
    const identityTrack = this.requestedTrackForIdentity(searchTrack);

    const normalizedLimit = Math.max(1, Math.min(20, Number(limit || 6)));
    const cacheKey = `exact:${strict ? "strict" : "loose"}:${normalizeMatchText(track.artist)}|${normalizeMatchText(track.title)}:${normalizedLimit}:${queries.length}:${includePageYear ? "page" : "detail"}:${this.identityDisambiguation.highConfidenceThreshold}:${this.identityDisambiguation.minimumConfidenceMargin}:${this.identityDisambiguation.alternateVersionThreshold}:${this.identityDisambiguation.legacyEraGapYears}:${this.identityDisambiguation.legacyOriginalYearCutoff}`;
    if (this.cache.has(cacheKey)) {
      this.lastExactIdentityDiagnostics = this.exactIdentityDiagnosticsCache.get(cacheKey) || null;
      return this.cache.get(cacheKey);
    }

    let bestResult = null;
    let bestExactSelection = null;
    const exactCandidates = [];
    let ambiguousSelection = null;
    let canonicalFallbackAttempted = false;
    const canonicalFallbackCandidates = [];
    const legacySearchDiagnostics = emptyLegacySearchDiagnostics(identityTrack);
    const addExactCandidates = (items) => {
      const seen = new Set(exactCandidates.map(item => String(item.id || item.tidalUrl || `${item.artist}|${item.title}`)));
      for (const item of items || []) {
        const key = String(item.id || item.tidalUrl || `${item.artist}|${item.title}`);
        if (!seen.has(key)) { seen.add(key); exactCandidates.push(item); }
      }
    };
    for (const plan of plans) {
      const query = plan.query;
      const searchUrl = createSearchUrl(query, "tracks");
      searchUrl.searchParams.set("countryCode", this.countryCode);
      searchUrl.searchParams.set("include", "tracks");

      const searchJson = await this.fetchTidalJson(searchUrl.toString());
      const packet = this.prepareExactCandidates(identityTrack, getItems(searchJson).slice(0, normalizedLimit), searchJson, plan);
      recordLegacySearchQuery(legacySearchDiagnostics, packet.retrieval);
      // Do not let an incomplete tracks-only row satisfy the identity scorer
      // through an empty artist set; retain it for detail expansion below.
      const pageCandidates = packet.candidates.filter(item => item.artist);
      addExactCandidates(pageCandidates);
      const exactSelection = pageCandidates.length ? chooseExact(identityTrack, pageCandidates, this.identityDisambiguation) : null;
      if (exactSelection?.status === "AMBIGUOUS") {
        ambiguousSelection = exactSelection;
      }
      let candidate = exactSelection?.match
        ? { entry: exactSelection.match, index: 0, score: candidateMatchScore(exactSelection.match, track, {}, { strict }) }
        : pageCandidates.map((entry, index) => ({ entry, index, score: candidateMatchScore(entry, identityTrack, {}, { strict }) }))
          .filter(candidate => candidate.score > 0)
          .sort((left, right) => right.score - left.score || left.index - right.index)[0] || null;
      if (!candidate && searchNeedsDetailExpansion(searchJson)) {
        candidate = await this.chooseCandidateResultWithDetails(searchJson, identityTrack, query, { strict, searchPlan: plan });
      }

      if (!plan.searchStage.startsWith("exact-artist")) {
        canonicalFallbackAttempted = true;
        canonicalFallbackCandidates.push({ label: plan.searchStage, query, returnedCount: packet.evaluated.length, candidateIds: packet.evaluated.map(item => String(item.id || "")).filter(Boolean) });
      }
      const result = resultFromCandidate(candidate, searchJson, query, identityTrack);
      if (!result) continue;
      result.legacySearchDiagnostics = legacySearchDiagnostics;
      if (!bestResult || Number(result.matchScore || 0) > Number(bestResult.matchScore || 0)) {
        bestResult = result;
        bestExactSelection = exactSelection?.match ? exactSelection : null;
      }
      if (Number(result.matchScore || 0) >= (strict ? 175 : 145)) break;
    }

    // Search variants above can return the same shallow window for a legacy
    // title. Give the resolver one final canonical pool so version mismatch
    // and ambiguity are decided across all returned rows, not per query.
    if (!strict && (!bestResult || ambiguousSelection)) {
      canonicalFallbackAttempted = true;
      for (const plan of this.exactSearchPlans(searchTrack, { strict: false })) {
        const { searchStage: label, query } = plan;
        if (queries.includes(query)) continue;
        const searchUrl = createSearchUrl(query, "tracks");
        searchUrl.searchParams.set("countryCode", this.countryCode);
        searchUrl.searchParams.set("include", "tracks");
        const searchJson = await this.fetchTidalJson(searchUrl.toString());
        const packet = this.prepareExactCandidates(identityTrack, getItems(searchJson).slice(0, normalizedLimit), searchJson, plan);
        recordLegacySearchQuery(legacySearchDiagnostics, packet.retrieval);
        const pageCandidates = packet.candidates.filter(item => item.artist);
        addExactCandidates(pageCandidates);
        canonicalFallbackCandidates.push({ label, query, returnedCount: packet.evaluated.length, candidateIds: packet.evaluated.map(item => String(item.id || "")).filter(Boolean) });
      }
    }

    const combinedExactSelection = exactCandidates.length
      ? chooseExact(identityTrack, exactCandidates, this.identityDisambiguation) : null;
    if (combinedExactSelection?.status === "AMBIGUOUS") ambiguousSelection = combinedExactSelection;
    else if (combinedExactSelection?.match) {
      const candidate = { entry: combinedExactSelection.match, index: 0, score: candidateMatchScore(combinedExactSelection.match, track, {}, { strict }) };
      const result = resultFromCandidate(candidate, { data: [], included: [] }, "canonical", identityTrack);
      if (result) {
        bestResult = result;
        bestExactSelection = combinedExactSelection;
        result.legacySearchDiagnostics = legacySearchDiagnostics;
      }
    }

    finalizeLegacySearchDiagnostics(legacySearchDiagnostics, { selected: Boolean(bestResult || bestExactSelection?.match) });

    if (ambiguousSelection && !bestExactSelection) {
      this.lastExactIdentityDiagnostics = {
        failureType: "AMBIGUOUS",
        identityOutcome: "AMBIGUOUS",
        candidateIdentities: ambiguousSelection.candidateIdentities || [],
        identityRules: ["multiple-exact-tidal-candidates", ...(ambiguousSelection.candidatesCollapsedAsSameRecording ? ["canonical-recording-collapse-insufficient-to-resolve"] : [])],
        candidatesCollapsedAsSameRecording: Boolean(ambiguousSelection.candidatesCollapsedAsSameRecording),
        collapsedRecordingCount: Number(ambiguousSelection.collapsedRecordingCount || 0),
        canonicalCandidateGroups: ambiguousSelection.canonicalCandidateGroups || [],
        canonicalCandidateSelected: ambiguousSelection.canonicalCandidateSelected || null,
        canonicalizationReason: ambiguousSelection.canonicalizationReason || "",
        versionPreferenceApplied: Boolean(ambiguousSelection.versionPreferenceApplied),
        legacyCanonicalPreferenceApplied: Boolean(ambiguousSelection.legacyCanonicalPreferenceApplied),
        legacyCanonicalScore: ambiguousSelection.legacyCanonicalScore ?? null,
        modernReinterpretationPenalty: ambiguousSelection.modernReinterpretationPenalty ?? 0,
        originalEraCandidate: ambiguousSelection.originalEraCandidate ?? false,
        eraGapYears: ambiguousSelection.eraGapYears ?? null,
        topCandidateScore: ambiguousSelection.topCandidateScore ?? null,
        runnerUpScore: ambiguousSelection.runnerUpScore ?? null,
        confidenceMargin: ambiguousSelection.confidenceMargin ?? null,
        ambiguityResolvedBy: ambiguousSelection.ambiguityResolvedBy || "",
        legacySearchDiagnostics,
        canonicalFallbackAttempted,
        canonicalFallbackCandidates,
        canonicalFallbackOutcome: "AMBIGUOUS",
        validatedIdentityLookup: this.lastValidatedIdentityLookup,
        validatedIdentityReuseDiagnostics: this.lastValidatedIdentityReuseDiagnostics,
        finalIdentityOutcome: "AMBIGUOUS"
      };
      this.exactIdentityDiagnosticsCache.set(cacheKey, this.lastExactIdentityDiagnostics);
      this.cache.set(cacheKey, null);
      return null;
    }

    if (!bestResult) {
      const validatedSelection = await this.findValidatedIdentity(searchTrack, this.identityDisambiguation);
      if (validatedSelection?.match) {
        const reused = {
          ...validatedSelection.match,
          identityOutcome: validatedSelection.identityOutcome,
          identityConfidence: validatedSelection.confidenceScore,
          identityDiagnostics: validatedSelection.identityDiagnostics,
          validatedIdentityReuse: true,
          validatedIdentitySource: validatedSelection.validatedIdentitySource || "validated-identity-lookup"
        };
        this.lastExactIdentityDiagnostics = {
          failureType: "",
          identityOutcome: validatedSelection.identityOutcome,
          candidateIdentities: validatedSelection.candidateIdentities || [],
          identityRules: ["validated-tidal-identity-reused-before-not-found"],
          expectedLegacyEra: validatedSelection.expectedLegacyEra ?? null,
          expectedLegacyEraSource: validatedSelection.expectedLegacyEraSource || "",
          validatedIdentityReuse: true,
          validatedIdentitySource: validatedSelection.validatedIdentitySource || "validated-identity-lookup",
          legacySearchDiagnostics,
          canonicalFallbackAttempted,
          canonicalFallbackCandidates,
          canonicalFallbackOutcome: "validated-identity-reuse",
          validatedIdentityLookup: this.lastValidatedIdentityLookup,
          validatedIdentityReuseDiagnostics: this.lastValidatedIdentityReuseDiagnostics,
          finalIdentityOutcome: validatedSelection.finalIdentityOutcome || validatedSelection.identityOutcome
        };
        this.exactIdentityDiagnosticsCache.set(cacheKey, this.lastExactIdentityDiagnostics);
        this.cache.set(cacheKey, reused);
        return reused;
      }
    }

    if (!bestResult && attempt < 1 && !this.useProfileAccessToken && await this.enableProfileAccessTokenFallback()) {
      return this.findExactTrack(track, {
        strict,
        limit: normalizedLimit,
        includePageYear,
        maxQueries: queries.length
      }, attempt + 1);
    }

    const finalResult = bestResult && includePageYear ? await this.withPageYear(bestResult) : bestResult;
    this.lastExactIdentityDiagnostics = finalResult?.identityDiagnostics ? {
      failureType: "",
      identityOutcome: bestExactSelection?.identityOutcome || finalResult.identityOutcome || "VERIFIED_EXACT",
      candidateIdentities: bestExactSelection?.candidateIdentities || [{
        id: finalResult.id || "",
        artist: finalResult.artist || "",
        title: finalResult.title || "",
        identityOutcome: finalResult.identityOutcome || "VERIFIED_EXACT",
        confidenceScore: finalResult.identityConfidence ?? null
      }],
      identityRules: finalResult.identityDiagnostics.reasons || [],
      legacyIdentityDiagnostics: finalResult.identityDiagnostics.legacyIdentityDiagnostics || null,
      candidatesCollapsedAsSameRecording: Boolean(bestExactSelection?.candidatesCollapsedAsSameRecording),
      collapsedRecordingCount: Number(bestExactSelection?.collapsedRecordingCount || 0),
      canonicalCandidateGroups: bestExactSelection?.canonicalCandidateGroups || [],
      canonicalCandidateSelected: bestExactSelection?.canonicalCandidateSelected || null,
      canonicalizationReason: bestExactSelection?.canonicalizationReason || "",
      versionPreferenceApplied: Boolean(bestExactSelection?.versionPreferenceApplied),
      legacyCanonicalPreferenceApplied: Boolean(bestExactSelection?.legacyCanonicalPreferenceApplied),
      legacyCanonicalScore: bestExactSelection?.legacyCanonicalScore ?? null,
      modernReinterpretationPenalty: bestExactSelection?.modernReinterpretationPenalty ?? 0,
      originalEraCandidate: bestExactSelection?.originalEraCandidate ?? false,
      eraGapYears: bestExactSelection?.eraGapYears ?? null,
      topCandidateScore: bestExactSelection?.topCandidateScore ?? finalResult.identityConfidence ?? null,
      runnerUpScore: bestExactSelection?.runnerUpScore ?? null,
      confidenceMargin: bestExactSelection?.confidenceMargin ?? null,
      ambiguityResolvedBy: bestExactSelection?.ambiguityResolvedBy || "",
      legacySearchDiagnostics,
      canonicalFallbackAttempted,
      canonicalFallbackCandidates,
      canonicalFallbackOutcome: canonicalFallbackAttempted ? "resolved" : "not-needed",
      validatedIdentityLookup: this.lastValidatedIdentityLookup,
      validatedIdentityReuseDiagnostics: this.lastValidatedIdentityReuseDiagnostics,
      finalIdentityOutcome: bestExactSelection?.finalIdentityOutcome || finalResult.identityOutcome || "VERIFIED_EXACT"
    } : {
      failureType: "NOT_FOUND",
      identityOutcome: "NOT_FOUND",
      candidateIdentities: [],
      identityRules: ["no-safe-tidal-catalogue-candidate"],
      legacyIdentityDiagnostics: null,
      canonicalCandidateGroups: [],
      canonicalCandidateSelected: null,
      canonicalizationReason: "",
      versionPreferenceApplied: false,
      legacyCanonicalPreferenceApplied: false,
      legacyCanonicalScore: null,
      modernReinterpretationPenalty: 0,
      originalEraCandidate: false,
      eraGapYears: null,
      topCandidateScore: null,
      runnerUpScore: null,
      confidenceMargin: null,
      ambiguityResolvedBy: "",
      legacySearchDiagnostics,
      canonicalFallbackAttempted,
      canonicalFallbackCandidates,
      canonicalFallbackOutcome: canonicalFallbackAttempted ? "not-found" : "not-needed",
      validatedIdentityLookup: this.lastValidatedIdentityLookup,
      validatedIdentityReuseDiagnostics: this.lastValidatedIdentityReuseDiagnostics,
      finalIdentityOutcome: "NOT_FOUND"
    };
    this.exactIdentityDiagnosticsCache.set(cacheKey, this.lastExactIdentityDiagnostics);
    this.cache.set(cacheKey, finalResult || null);
    return finalResult || null;
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

    try {
      const exactCandidate = await this.findExactTrack(track, { strict, limit: 6, includePageYear: false });
      if (exactCandidate) {
        if (Number(exactCandidate.matchScore || 0) >= highConfidenceScore) {
          const verified = await this.withPageYear(exactCandidate);
          this.cache.set(cacheKey, verified);
          return verified;
        }
        fallbackResult = exactCandidate;
      }
    } catch (error) {
      lastError = error;
    }

    for (const plan of this.exactSearchPlans(track, { strict })) {
      const query = plan.query;
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

  async searchExactCandidates(track, { id = "", queryOverride = "", searchPlan = null, requestedTrack = null, signal, timeoutMs = 12000, logger = () => {} } = {}) {
    const identityTrack = requestedTrack || track;
    const query = normalizeExactSearchQuery(queryOverride || `${track.artist || ""} ${track.title || ""}`);
    const url = id ? new URL(`${TIDAL_TRACK_ROOT}/${encodeURIComponent(id)}`)
      : createSearchUrl(query, "tracks");
    url.searchParams.set("countryCode", this.countryCode);
    url.searchParams.set("include", id ? "artists,albums" : "tracks,tracks.artists,tracks.albums");
    const plan = id ? {
      searchStage: "exact-tidal-id",
      candidateSourceQuery: id,
      artistConstraintApplied: Boolean(track.artist),
      titleConstraintApplied: Boolean(track.title),
      expectedLegacyEra: expectedLegacyEraForTrack(track)
    } : searchPlan || this.exactSearchPlans(identityTrack, { strict: false }).find(item => item.query === query) || {
      searchStage: "ad-hoc-search",
      candidateSourceQuery: query,
      artistConstraintApplied: Boolean(track.artist),
      titleConstraintApplied: Boolean(track.title),
      expectedLegacyEra: expectedLegacyEraForTrack(identityTrack)
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try {
        const slot = Math.max(Date.now(), this.nextExactRequestAt || 0);
        this.nextExactRequestAt = slot + 400;
        if (slot > Date.now()) await require("node:timers/promises").setTimeout(slot - Date.now(), undefined, { signal });
        const token = await this.getAccessToken();
        signal?.throwIfAborted();
        const response = await fetchWithTimeout(url.toString(), { signal, headers: {
          accept: "application/vnd.api+json", authorization: `Bearer ${token}`
        } }, { fetchImpl: this.fetchImpl, timeoutMs, dnsRetries: 0, label: "TIDAL exact verification" });
        if (response.status === 404) {
          const empty = [];
          Object.defineProperty(empty, "legacySearchDiagnostics", { value: emptyLegacySearchDiagnostics(identityTrack), enumerable: false });
          return empty;
        }
        if (!response.ok) {
          const error = httpStatusError("TIDAL exact verification", response.status);
          // Never log raw bodies, headers, tokens, or provider error detail text.
          error.category = response.status === 400 ? "invalid_request" : response.status === 401 ? "authentication" : response.status === 429 ? "rate_limit" : "upstream_error";
          const retryAfter = response.headers?.get?.("retry-after");
          error.retryAfterMs = retryAfter ? (Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : 1500;
          if (response.status === 401 && attempt === 0 && (this.invalidateRejectedAccessToken(token) || await this.enableProfileAccessTokenFallback(token))) continue;
          throw error;
        }
        const json = toLegacySearchShape(await response.json(), id ? "" : "tracks");
        const rawItems = id ? [json.data].filter(Boolean) : getItems(json).slice(0, 20);
        const mappedItems = rawItems
          .map(item => {
            const result = buildResult(item, json, query);
            const version = cleanText(item.attributes?.version || item.version);
            const { normalize } = require("./exactTrackVerification");
            if (version && !normalize(result.title).endsWith(normalize(version))) result.title += ` (${version})`;
            return result;
          })
          .filter(item => item.artist && item.title && item.id);
        const packet = this.prepareExactCandidates(identityTrack, mappedItems, json, plan);
        const candidates = packet.candidates.sort((left, right) => right.retrievalScore - left.retrievalScore || String(left.id).localeCompare(String(right.id)));
        const diagnostics = emptyLegacySearchDiagnostics(identityTrack);
        recordLegacySearchQuery(diagnostics, packet.retrieval);
        finalizeLegacySearchDiagnostics(diagnostics, { selected: candidates.length > 0 });
        Object.defineProperty(candidates, "legacySearchDiagnostics", { value: diagnostics, enumerable: false });
        return candidates;
      } catch (error) {
        logger({ endpointType: id ? "track" : "search_tracks", normalizedQuery: query, requestMode: "exact_track_verification", httpStatus: error.status || null, errorCategory: error.category || (signal?.aborted ? "timeout" : "network"), networkCode: error.code || error.cause?.code || "", retryCount: attempt, timeoutMs, track: { artist: track.artist || "", title: track.title || "" } });
        if (attempt || signal?.aborted || !(error.retryable || /fetch failed|ECONNRESET/.test(error.message))) throw error;
        await require("node:timers/promises").setTimeout(Math.max(400, error.retryAfterMs || 1500), undefined, { signal });
      }
    }
    return [];
  }

  async searchTracks(query, {
    limit = 10,
    detailLimit = 3,
    fullPage = false,
    standbyFresh = false,
    rotateCatalog = false,
    catalogAnchor = query,
    pageCount = 1,
    onPagination
  } = {}) {
    if (!this.isConfigured()) return [];
    const normalizedLimit = Math.max(1, Math.min(20, Number(limit || 10)));
    const normalizedDetailLimit = Math.max(0, Math.min(normalizedLimit, Number(detailLimit || 0)));
    const include = "tracks.artists,tracks.albums";
    // TIDAL chooses its page size; `limit` does not bound the returned page.
    // A cursor must never advance past rows discarded by a local slice.
    const consumeFullPage = fullPage || rotateCatalog || Number(pageCount) > 1;
    const searchUrl = createSearchUrl(query, "tracks");
    searchUrl.searchParams.set("countryCode", this.countryCode);
    searchUrl.searchParams.set("include", `tracks,${include}`);

    return this.fetchCatalogPages({
      pageCount,
      source: "searchTracks",
      anchor: catalogAnchor,
      baseUrl: searchUrl.toString(),
      rotate: Boolean(rotateCatalog),
      cacheVariant: `${normalizedLimit}:${normalizedDetailLimit}:${standbyFresh}:${include}:${consumeFullPage}`,
      getPageItems: getItems,
      mapItems: async (pageItems, searchJson) => {
        const results = [];
        let index = 0;
        for (const item of consumeFullPage ? pageItems : pageItems.slice(0, normalizedLimit)) {
          const result = buildResult(item, searchJson, query);
          if (!result.title || !result.tidalUrl) continue;
          const needsDetail = !result.artist || !result.album || index < normalizedDetailLimit;
          const enriched = needsDetail ? await this.withDetailYear(result) : result;
          if (!enriched.title || !enriched.artist || !enriched.tidalUrl) continue;
          results.push(withCatalogVersion(enriched));
          index += 1;
        }
        return results;
      },
      onPagination
    });
  }

  async resolveArtist(artistName) {
    if (!this.isConfigured()) return null;
    const cacheKey = `artist:${normalizeMatchText(artistName)}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const searchUrl = createSearchUrl(artistName, "artists");
    searchUrl.searchParams.set("countryCode", this.countryCode);
    searchUrl.searchParams.set("include", "artists");

    const searchJson = await this.fetchTidalJson(searchUrl.toString());
    const artist = chooseExactArtist(searchJson, artistName);
    const result = artist ? {
      id: cleanText(artist.id),
      name: cleanText(artist.attributes?.name || artist.name)
    } : null;

    this.cache.set(cacheKey, result);
    return result;
  }

  async getArtistAlbums(artistName, {
    limit = 8,
    rotateCatalog = false,
    catalogAnchor = artistName,
    pageCount = 1,
    onPagination
  } = {}) {
    const artist = await this.resolveArtist(artistName);
    if (!artist?.id) return [];

    const normalizedLimit = Math.max(1, Math.min(20, Number(limit || 8)));
    const albumsUrl = new URL(`https://openapi.tidal.com/v2/artists/${encodeURIComponent(artist.id)}/relationships/albums`);
    albumsUrl.searchParams.set("countryCode", this.countryCode);
    albumsUrl.searchParams.set("include", "albums");
    albumsUrl.searchParams.set("limit", String(normalizedLimit));

    return this.fetchCatalogPages({
      pageCount,
      source: "getArtistAlbums",
      anchor: catalogAnchor || artist.id,
      baseUrl: albumsUrl.toString(),
      rotate: Boolean(rotateCatalog),
      cacheVariant: String(normalizedLimit),
      getPageItems: (albumsJson) => collectionItems(albumsJson, "albums"),
      mapItems: async (pageItems) => pageItems.map((album) => ({
        id: cleanText(album.id),
        title: cleanText(album.attributes?.title || album.title),
        label: getLabel({}, album),
        year: getReleaseYear({}, album),
        releaseDate: getReleaseDate({}, album),
        releaseEvidence: getReleaseEvidence({}, album),
        artist: artist.name
      })).filter((album) => album.id && album.title),
      onPagination
    });
  }

  async getAlbumTracks(album, {
    limit = 12,
    fullPage = false,
    rotateCatalog = false,
    catalogAnchor = album?.id || "",
    pageCount = 1,
    onPagination
  } = {}) {
    if (!album?.id) return [];
    const normalizedLimit = Math.max(1, Math.min(30, Number(limit || 12)));
    const consumeFullPage = fullPage || rotateCatalog || Number(pageCount) > 1;

    // TIDAL's current v2 API exposes the album track list reliably through
    // the album collection resource. The relationship endpoint rejects the
    // old `include=tracks,albums,artists` path (and some catalog versions
    // return 404 even though the album itself is valid). Ask for the album's
    // `items` and nested item artists instead, as documented by TIDAL's
    // JSON:API shape.
    const albumUrl = new URL("https://openapi.tidal.com/v2/albums");
    albumUrl.searchParams.set("countryCode", this.countryCode);
    albumUrl.searchParams.set("filter[id]", String(album.id));
    albumUrl.searchParams.set("include", "items,items.artists");
    albumUrl.searchParams.set("limit", "1");

    return this.fetchCatalogPages({
      pageCount,
      source: "getAlbumTracks",
      anchor: catalogAnchor || album.id,
      baseUrl: albumUrl.toString(),
      rotate: Boolean(rotateCatalog),
      cacheVariant: `${normalizedLimit}:${consumeFullPage}`,
      relationshipNames: ["items"],
      getPageItems: albumTrackItems,
      mapItems: async (pageItems, albumJson) => {
        const tracks = [];
        for (const item of consumeFullPage ? pageItems : pageItems.slice(0, normalizedLimit)) {
          let result = buildResult(item, albumJson, `${album.artist} ${album.title}`);
          if ((!result.title || !result.artist || !result.tidalUrl) && item?.id) {
            result = await this.getTrack(item.id, `${album.artist} ${album.title}`);
          }
          if (!result) continue;
          const track = {
            ...result,
            album: result.album || album.title || "",
            label: result.label || album.label || "",
            year: result.year || album.year || null,
            releaseDate: result.releaseDate || album.releaseDate || "",
            releaseEvidence: Object.keys(result.releaseEvidence || {}).length
              ? result.releaseEvidence
              : (album.releaseEvidence || {})
          };
          if (track.title && track.artist && track.tidalUrl) tracks.push(withCatalogVersion(track));
        }
        return tracks;
      },
      onPagination
    });
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
      detailUrl.searchParams.set("include", "albums,artists,albums.coverArt");
      const detailJson = await this.fetchTidalJson(detailUrl.toString());
      const track = detailJson?.data || {};
      const album = getAlbum(track, detailJson);
      const year = getReleaseYear(track, album);
      const releaseDate = getReleaseDate(track, album);
      const artist = cleanText(getArtistNames(track, detailJson).join(", "));
      const artistRefs = getArtistRefs(track, detailJson);
      const artistIds = artistRefs.map((entry) => entry.id).filter(Boolean);
      const version = cleanText(track.version || track.attributes?.version);

      return {
        ...result,
        title: cleanText(track.title || track.attributes?.title) || result.title,
        version: version || result.version || "",
        mixVersion: version || result.mixVersion || "",
        artist: artist || result.artist,
        artists: artistRefs.length ? artistRefs : (result.artists || []),
        artistIds: artistIds.length ? artistIds : (result.artistIds || []),
        album: cleanText(album.title || album.attributes?.title) || result.album,
        label: getLabel(track, album) || result.label || "",
        year: year || result.year,
        releaseDate: releaseDate || result.releaseDate || "",
        releaseEvidence: getReleaseEvidence(track, album),
        durationMs: getDurationMs(track) || result.durationMs,
        isrc: getIsrc(track) || result.isrc || "",
        imageUrl: getImageUrl(track, album, detailJson) || result.imageUrl || "",
        mediaTags: getMediaTags(track).length ? getMediaTags(track) : (result.mediaTags || []),
        audioQuality: getAudioQuality(track) || result.audioQuality || "",
        sampleRateKhz: getSampleRateKhz(track) || result.sampleRateKhz || null,
        bitDepth: getBitDepth(track) || result.bitDepth || null,
        channels: getChannelCount(track) || result.channels || null,
        yearSource: year ? "tidal-detail" : result.yearSource,
        sourceEvidence: [captureTidalEvidence(track, album, detailJson)]
      };
    } catch {
      return result;
    }
  }

  async searchV2(track, query, options = {}) {
    const searchUrl = createSearchUrl(query, "tracks");
    searchUrl.searchParams.set("countryCode", this.countryCode);
    searchUrl.searchParams.set("include", "tracks");

    const searchJson = await this.fetchTidalJson(searchUrl.toString());
    const searchPlan = this.exactSearchPlans(track, { strict: Boolean(options.strict) }).find(plan => plan.query === normalizeExactSearchQuery(query)) || {
      searchStage: "ad-hoc-search",
      candidateSourceQuery: normalizeExactSearchQuery(query),
      artistConstraintApplied: Boolean(track.artist),
      titleConstraintApplied: Boolean(track.title)
    };
    const packet = this.prepareExactCandidates(track, getItems(searchJson), searchJson, searchPlan);
    let candidate = packet.candidates
      .map((entry, index) => ({ entry, index, score: candidateMatchScore(entry, this.requestedTrackForIdentity(track), {}, options) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)[0] || null;
    if (!candidate && searchNeedsDetailExpansion(searchJson)) {
      candidate = await this.chooseCandidateResultWithDetails(searchJson, this.requestedTrackForIdentity(track), query, { ...options, searchPlan });
    }
    const result = resultFromCandidate(candidate, searchJson, query, this.requestedTrackForIdentity(track));
    if (result) result.legacySearchDiagnostics = packet.retrieval;
    return result;
  }

  async chooseCandidateResultWithDetails(searchJson, track = {}, query = "", options = {}) {
    const candidates = [];
    const highConfidenceScore = options.strict ? 175 : 145;
    const packet = this.prepareExactCandidates(track, getItems(searchJson).slice(0, 8), searchJson, {
      ...(options.searchPlan || {}),
      candidateSourceQuery: query,
      searchStage: options.searchPlan?.searchStage || "detail-expansion"
    });
    let index = 0;
    for (const item of packet.candidates) {
      const result = item;
      if (!result.title || !result.tidalUrl) {
        index += 1;
        continue;
      }
      const enriched = await this.withDetailYear(result);
      const score = candidateMatchScore(enriched, track, {}, options);
      if (score >= highConfidenceScore) return { entry: enriched, index, score };
      if (score > 0) candidates.push({ entry: enriched, index, score });
      index += 1;
    }
    return candidates.sort((left, right) => right.score - left.score || left.index - right.index)[0] || null;
  }

  async searchLegacy(track, query, options = {}) {
    const searchUrl = new URL(TIDAL_LEGACY_SEARCH_URL);
    searchUrl.searchParams.set("query", query);
    searchUrl.searchParams.set("countryCode", this.countryCode);
    searchUrl.searchParams.set("limit", "20");

    const searchJson = await this.fetchTidalJson(searchUrl.toString());
    const searchPlan = this.exactSearchPlans(track, { strict: Boolean(options.strict) }).find(plan => plan.query === normalizeExactSearchQuery(query)) || {
      searchStage: "legacy-ad-hoc-search",
      candidateSourceQuery: normalizeExactSearchQuery(query),
      artistConstraintApplied: Boolean(track.artist),
      titleConstraintApplied: Boolean(track.title)
    };
    const packet = this.prepareExactCandidates(track, getItems(searchJson), searchJson, searchPlan);
    const candidate = packet.candidates
      .map((entry, index) => ({ entry, index, score: candidateMatchScore(entry, this.requestedTrackForIdentity(track), {}, options) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)[0] || null;
    if (!candidate) return null;
    return { ...candidate.entry, matchScore: candidate.score, legacySearchDiagnostics: packet.retrieval };
  }

  async fetchTidalJson(url, attempt = 0) {
    const token = await this.getAccessToken();
    const now = this.clock();
    if (this.nextRequestAt > now) await this.sleep(this.nextRequestAt - now);

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
       await this.sleep(Math.max(1, retryAfter) * 1000);
      return this.fetchTidalJson(url, attempt + 1);
    }

    this.nextRequestAt = this.clock() + 275;
    if (response.status === 404) return null;
    if (response.status === 401) {
      if (attempt < 1 && this.invalidateRejectedAccessToken(token)) {
        return this.fetchTidalJson(url, attempt + 1);
      }
      if (attempt < 2 && await this.enableProfileAccessTokenFallback(token)) {
        return this.fetchTidalJson(url, attempt + 1);
      }
      const error = new Error(this.accessToken
        ? "Configured TIDAL_ACCESS_TOKEN was rejected by TIDAL. Remove it or configure TIDAL_CLIENT_ID/TIDAL_CLIENT_SECRET so Rabbit Hole can fetch a fresh catalog token."
        : this.profileAccessTokenProvider
          ? "TIDAL catalog token was rejected. Rabbit Hole also tried the TIDAL profile OAuth token; reconnect TIDAL if this persists."
          : "TIDAL catalog token was rejected. Check TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET.");
      error.status = 401;
      error.source = "tidal";
      throw error;
    }
    if (!response.ok) throw httpStatusError("TIDAL API lookup", response.status);
    return toLegacySearchShape(await response.json(), searchRelationForUrl(url));
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
    if (this.profileAccessToken && rejected === this.profileAccessToken) {
      this.profileAccessTokenRejected = true;
      this.useProfileAccessToken = false;
      return false;
    }
    return false;
  }

  async enableProfileAccessTokenFallback(rejectedToken = "") {
    if (!this.profileAccessTokenProvider || this.profileAccessTokenRejected) return false;
    const profileToken = cleanText(await this.profileAccessTokenProvider().catch(() => ""));
    if (!profileToken || profileToken === cleanText(rejectedToken)) return false;
    this.profileAccessToken = profileToken;
    this.useProfileAccessToken = true;
    return true;
  }

  async getAccessToken() {
    if (this.useProfileAccessToken && this.profileAccessToken && !this.profileAccessTokenRejected) {
      return this.profileAccessToken;
    }

    if (this.accessToken && !this.staticAccessTokenRejected) return this.accessToken;

    const now = this.clock();
    if (this.token?.accessToken && this.token.expiresAtMs - now > 60_000) return this.token.accessToken;
    if (!this.clientId || !this.clientSecret) {
      if (await this.enableProfileAccessTokenFallback()) return this.profileAccessToken;
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
  trackSourceQualityFromMetadata,
  buildExactSearchPlans,
  rankExactCatalogCandidates
};
