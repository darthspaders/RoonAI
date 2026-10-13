"use strict";

const { matchBeatportVersionToTidal } = require("./beatportVersionMatch");
const { artistCreditSetKey, classifyVersionText, durationMilliseconds,
  normalizeAlbumFamily, normalizeCatalogText, parseCanonicalCatalogIdentity,
  versionDescriptorFromTitle, stripVersionDescriptorFromTitle } = require("./catalogIdentityNormalization");

const MAX_CACHE_ENTRIES = 256;
const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const DURATION_TOLERANCE_MS = 5000;
const present = value => value !== undefined && value !== null && value !== "";
const text = value => typeof value === "string" ? value.trim() : "";
const clone = value => structuredClone(value);
const isrc = value => text(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
const validIsrc = value => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc(value));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function isoDate(value) {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date ? date : "";
}

function identity(track) {
  if (!track || typeof track !== "object" || !text(track.artist) || !text(track.title)) return null;
  const namedCredits = artistCreditSetKey(track.artist);
  const credits = Array.isArray(track.artists) && track.artists.length ? artistCreditSetKey(track.artists) : namedCredits;
  if (!credits || credits !== namedCredits) return null;
  const parsed = parseCanonicalCatalogIdentity(track);
  const descriptors = [versionDescriptorFromTitle(track.title),
    ...["mixVersion", "mixName", "version", "remix"].filter(key => present(track[key])).map(key => classifyVersionText(track[key]))]
    .filter(version => version.explicit);
  if (!parsed.normalizedBaseTitle || !descriptors.length || !["original", "extended"].includes(parsed.versionKind)) return null;
  // Do not let a separate mix field conceal a remix/edit in the title. Club,
  // named variants and alternate descriptors are not generic Extended proof.
  if (!descriptors.every(version => version.kind === parsed.versionKind
    && new RegExp(`^${parsed.versionKind}(?: mix| version)?$`).test(version.normalized))) return null;
  return { ...parsed, credits };
}

function sameIdentity(request, provider) {
  const wanted = identity(request), found = identity(provider);
  return Boolean(wanted && found && wanted.credits === found.credits
    && wanted.normalizedBaseTitle === found.normalizedBaseTitle
    && wanted.versionKind === found.versionKind
    && JSON.stringify([...wanted.normalizedFeaturedArtists].sort()) === JSON.stringify([...found.normalizedFeaturedArtists].sort()));
}

function providerId(track) {
  const ids = [track?.id, track?.trackId, track?.track_id, track?.beatportTrackId, track?.beatportId, track?.beatport?.id,
    track?.rawJson?.id, track?.rawJson?.track_id, track?.rawJson?.attributes?.id]
    .filter(present).map(String);
  return ids.length && ids.every(id => /^[1-9]\d*$/.test(id) && id === ids[0]) ? ids[0] : "";
}

function factsAgree(request, provider) {
  for (const value of [request.isrc, request.ISRC].filter(present))
    if (!validIsrc(value) || isrc(value) !== isrc(provider.isrc)) return false;
  for (const key of ["durationMs", "duration_ms", "durationMilliseconds", "duration"]) {
    if (!present(request[key])) continue;
    const duration = durationMilliseconds({ [key]: request[key] });
    if (duration === null || Math.abs(duration - provider.durationMs) > DURATION_TOLERANCE_MS) return false;
  }
  const ids = [request.beatportTrackId, request.beatportId, request.beatport?.id].filter(present).map(String);
  if (ids.some(id => id !== providerId(provider))) return false;
  const albums = [typeof request.album === "object" ? request.album?.title : request.album, request.releaseTitle, request.release?.title];
  for (const album of albums.filter(present))
    if (!text(album) || !text(provider.album) || normalizeAlbumFamily(album) !== normalizeAlbumFamily(provider.album)) return false;
  if (present(request.label) && (!text(request.label) || !text(provider.label) || normalizeCatalogText(request.label) !== normalizeCatalogText(provider.label))) return false;
  for (const date of [request.releaseDate, request.release_date].filter(present))
    if (!isoDate(date) || isoDate(date) !== isoDate(provider.releaseDate)) return false;
  if (present(request.year)) {
    const year = /^\d{4}$/.test(String(request.year)) ? Number(request.year) : Number(isoDate(request.year).slice(0, 4));
    if (!year || !isoDate(provider.releaseDate) || year !== Number(provider.releaseDate.slice(0, 4))) return false;
  }
  return true;
}

function sourceUrl(track) {
  const id = providerId(track);
  if (!id) return "";
  const supplied = track.beatportUrl || track.url;
  if (!present(supplied)) return `https://www.beatport.com/track/${id}`;
  try {
    const url = new URL(supplied);
    if (url.protocol !== "https:" || !/^(?:www\.)?beatport\.com$/.test(url.hostname)
      || url.username || url.password || url.search || url.hash || !new RegExp(`^/track/(?:[^/]+/)?${id}/?$`).test(url.pathname)) return "";
    return url.toString();
  } catch { return ""; }
}

function checkedDetail(request, detail, selectedId) {
  if (!sameIdentity(request, detail) || !providerId(detail) || selectedId && providerId(detail) !== selectedId
    || detail.source && detail.source !== "beatport" || !validIsrc(detail.isrc)
    || !Number.isFinite(detail.durationMs) || detail.durationMs <= 0 || !factsAgree(request, detail)) return null;
  for (const key of ["album", "label"]) if (present(detail[key]) && !text(detail[key])) return null;
  if (present(detail.releaseDate) && !isoDate(detail.releaseDate)) return null;
  const match = matchBeatportVersionToTidal(request, detail, { allowVersionProxy: false, requestedBeatportTrackId: providerId(detail) });
  if (!match.matched || match.relation !== "exact" || match.diagnostics?.artistAliasApplied || match.diagnostics?.strongIdentityOverrideApplied) return null;
  if (!sourceUrl(detail)) return null;
  return { ...clone(detail), id: providerId(detail), isrc: isrc(detail.isrc) };
}

function selectSearchRow(request, rows) {
  const plausible = rows.filter(row => sameIdentity(request, row));
  if (!plausible.length || plausible.some(row => !providerId(row))) return null;
  // A search result is only a locator. Multiple IDs can locate one recording
  // only when every row supplies compatible recording facts independently.
  if (plausible.length > 1) {
    const first = plausible[0];
    if (!validIsrc(first.isrc) || !Number.isFinite(first.durationMs) || first.durationMs <= 0
      || !plausible.every(row => validIsrc(row.isrc) && isrc(row.isrc) === isrc(first.isrc)
        && Number.isFinite(row.durationMs) && row.durationMs > 0)
      || Math.max(...plausible.map(row => row.durationMs)) - Math.min(...plausible.map(row => row.durationMs)) > DURATION_TOLERANCE_MS) return null;
  }
  return [...plausible].sort((left, right) => providerId(left).localeCompare(providerId(right), "en", { numeric: true }))[0];
}

function buildRequestedVersionEvidenceRequest(request, evidence) {
  try {
    if (evidence?.provider !== "beatport" || !text(evidence.checkedAt) || !Number.isFinite(Date.parse(evidence.checkedAt))) return null;
    const detail = checkedDetail(request, evidence.track);
    if (!detail || evidence.sourceUrl !== sourceUrl(detail)) return null;
    const enriched = clone(request);
    if (![enriched.isrc, enriched.ISRC].some(present)) enriched.isrc = detail.isrc;
    if (![enriched.album, enriched.releaseTitle, enriched.release?.title].some(present) && present(detail.album)) enriched.album = detail.album;
    if (!present(enriched.label) && present(detail.label)) enriched.label = detail.label;
    if (![enriched.releaseDate, enriched.release_date].some(present) && present(detail.releaseDate)) enriched.releaseDate = detail.releaseDate;
    if (["durationMs", "duration_ms", "durationMilliseconds", "duration"].every(key => !present(enriched[key]))) enriched.durationMs = detail.durationMs;
    enriched.requestedVersionEvidence = { provider: "beatport", track: detail, sourceUrl: evidence.sourceUrl, checkedAt: evidence.checkedAt };
    return enriched;
  } catch { return null; }
}

function createRequestedVersionEvidenceLookup({ beatport, clock = Date.now } = {}) {
  const cache = new Map(), flights = new Map();
  const now = () => Number(clock());
  function put(key, result) {
    cache.delete(key);
    while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { result, expiresAt: now() + (result ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  }
  async function perform(request, signal) {
    try {
      if (signal.aborted || typeof beatport?.searchTracks !== "function" || typeof beatport?.getTrackById !== "function"
        || typeof beatport.isConfigured === "function" && !beatport.isConfigured()) return null;
      const packet = await beatport.searchTracks({ query: `${request.artist.trim()} ${stripVersionDescriptorFromTitle(request.title).trim()}`, page: 1, perPage: 20 });
      if (signal.aborted) return null;
      if (!Array.isArray(packet?.tracks) || packet.tracks.length > 20) return null;
      const selected = selectSearchRow(request, packet.tracks);
      if (!selected || signal.aborted) return null;
      const detail = await beatport.getTrackById(providerId(selected));
      if (signal.aborted) return null;
      const checked = checkedDetail(request, detail, providerId(selected));
      if (!checked) return null;
      // Fresh detail cannot silently switch a search locator to another recording.
      if (present(selected.isrc) && (!validIsrc(selected.isrc) || isrc(selected.isrc) !== checked.isrc)
        || present(selected.durationMs) && (!Number.isFinite(selected.durationMs) || selected.durationMs <= 0
          || Math.abs(selected.durationMs - checked.durationMs) > DURATION_TOLERANCE_MS)) return null;
      return { provider: "beatport", track: checked, sourceUrl: sourceUrl(checked), checkedAt: new Date(now()).toISOString() };
    } catch { return null; }
  }
  function wait(flight, signal) {
    return new Promise(resolve => {
      const ticket = {}, finish = value => {
        if (!flight.waiters.delete(ticket)) return;
        signal?.removeEventListener("abort", onAbort);
        resolve(value ? clone(value) : null);
      };
      const onAbort = () => {
        finish(null);
        if (!flight.waiters.size) flight.controller.abort();
      };
      flight.waiters.add(ticket);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      flight.promise.then(value => finish(signal?.aborted ? null : value));
    });
  }
  return async function requestedVersionEvidenceLookup(track, { signal } = {}) {
    if (signal?.aborted || !identity(track)) return null;
    let request, key;
    try { request = clone(track); key = JSON.stringify(canonical(request)); } catch { return null; }
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.result ? clone(cached.result) : null;
    if (cached) cache.delete(key);
    let flight = flights.get(key);
    if (!flight || flight.controller.signal.aborted) {
      flight = { controller: new AbortController(), waiters: new Set() };
      flights.set(key, flight);
      flight.promise = Promise.resolve().then(() => perform(request, flight.controller.signal)).then(result => {
        if (!flight.controller.signal.aborted) put(key, result);
        return result;
      }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
    }
    return wait(flight, signal);
  };
}

module.exports = { createRequestedVersionEvidenceLookup, buildRequestedVersionEvidenceRequest };
