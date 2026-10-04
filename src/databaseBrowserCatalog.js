"use strict";

const { normalizeRating } = require("./feedbackRatings");
const { decodeVector } = require("./sonicEmbeddingStore");
const { MODEL, MODEL_VERSION, DIMENSIONS, validCoverageEmbedding } = require("./sonicCoverageIdentity");

const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
const fold = value => text(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const parse = (value, fallback = {}) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const unique = values => [...new Map(values.map(text).filter(Boolean).map(value => [fold(value), value])).values()];
const tags = value => unique(Array.isArray(value) ? value.filter(item => typeof item === "string") : typeof value === "string" ? value.split(/[,;\n]/) : []);
const qualityTag = value => /^(?:hires(?:_lossless)?|lossless|mqa|dolby[_ ]atmos|low|high|stereo)$/i.test(text(value));
const musicalTags = value => tags(value).filter(value => !qualityTag(value));
// A stored genre may legitimately contain commas ("Folk, World, & Country").
const genreValues = value => text(value) && !text(value).split(/[,;]+/).every(qualityTag) ? [text(value)] : [];
const positiveNumber = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const hasTable = (db, name) => Boolean(db?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const readRows = (db, table, query) => hasTable(db, table) ? db.prepare(query).all() : [];

function safeImage(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    // Beatport track images are sometimes banners; release art is square.
    if (/beatport\.com$/i.test(url.hostname) && /\/image_size\/\d+x\d+\//.test(url.pathname)) {
      const [, w, h] = url.pathname.match(/\/image_size\/(\d+)x(\d+)\//);
      if (Number(w) / Number(h) > 1.5 || Number(h) / Number(w) > 1.5) return "";
      url.pathname = url.pathname.replace(/\/image_size\/\d+x\d+\//, "/image_size/300x300/");
    }
    if (url.hostname === "resources.tidal.com") url.pathname = url.pathname.replace(/\/\d+x\d+\.jpg$/, "/320x320.jpg");
    return url.href;
  } catch { return ""; }
}

function artwork(raw = {}, provider = "", { preferOriginal = true } = {}) {
  const release = raw.release || {};
  const album = raw.album && typeof raw.album === "object" ? raw.album : {};
  // Never pick an artist portrait or a label logo as an album cover.
  const choices = provider === "beatport"
    ? [release.image?.uri, release.imageUrl, album.image?.uri, raw.imageUrl, raw.sourceImageUrl, raw.image?.uri]
    : [raw.imageUrl, raw.sourceImageUrl, album.imageUrl, album.coverUrl, release.image?.uri, raw.coverUrl, raw.artworkUrl];
  // The bridge is a presentation cache. Its original URL is the same snapshot's
  // source asset, not artwork borrowed from another track or release.
  if (preferOriginal && /^https?:\/\/art\.darthspader\.com\/art\//i.test(raw.imageUrl || "") && safeImage(raw.sourceImageUrl)) choices.unshift(raw.sourceImageUrl);
  if (typeof album.cover === "string" && /^[a-f0-9-]{36}$/i.test(album.cover)) {
    choices.push(`https://resources.tidal.com/images/${album.cover.replace(/-/g, "/")}/320x320.jpg`);
  }
  return choices.map(safeImage).find(Boolean) || "";
}

function readCatalog(db, sonicDb = db) {
  const identities = db.prepare("SELECT * FROM track_identity ORDER BY id").all();
  const identitiesById = new Map(identities.map(row => [row.id, row]));
  const aliases = new Map(readRows(db, "track_identity_alias", "SELECT alias_identity_id, canonical_identity_id FROM track_identity_alias").map(row => [row.alias_identity_id, row.canonical_identity_id]));
  const preparedIdentities = new Map(readRows(db, "sonic_coverage_work", "SELECT identity_key, resolved_identity_key FROM sonic_coverage_work WHERE state IN ('embedded', 'prepared') AND resolved_identity_key IS NOT NULL").map(row => [row.identity_key, row.resolved_identity_key]));
  const enrichments = new Map();
  const artworkHistory = new Map();
  const artworkRepairs = new Map(readRows(db, "canonical_artwork_repair", "SELECT * FROM canonical_artwork_repair WHERE revoked_at IS NULL ORDER BY created_at, id").map(row => [`${row.legacy_track_id}|${row.legacy_snapshot_id}|${row.original_url}`, row]));
  for (const row of readRows(db, "provider_enrichment", "SELECT * FROM provider_enrichment ORDER BY fetched_at DESC, id DESC")) {
    if (!artworkHistory.has(row.track_identity_id)) artworkHistory.set(row.track_identity_id, []);
    artworkHistory.get(row.track_identity_id).push({ ...row, raw: parse(row.raw_json) });
    if (!enrichments.has(row.track_identity_id)) enrichments.set(row.track_identity_id, new Map());
    const byProvider = enrichments.get(row.track_identity_id);
    if (!byProvider.has(row.provider)) byProvider.set(row.provider, { ...row, raw: parse(row.raw_json) });
  }
  const beatport = new Map(readRows(db, "beatport_enrichment", "SELECT * FROM beatport_enrichment").map(row => [row.track_identity_id, { ...row, raw: parse(row.raw_json) }]));
  const ratings = new Map();
  for (const row of readRows(db, "taste_feedback", "SELECT id, track_identity_id, rating, created_at FROM taste_feedback ORDER BY created_at DESC, id DESC")) {
    if (!ratings.has(row.track_identity_id)) ratings.set(row.track_identity_id, normalizeRating(row.rating, { fallback: "" }));
  }
  const sources = new Map();
  for (const row of readRows(db, "track_observation", "SELECT track_identity_id, source, MAX(observed_at) AS last_at FROM track_observation GROUP BY track_identity_id, source")) {
    if (!sources.has(row.track_identity_id)) sources.set(row.track_identity_id, []);
    sources.get(row.track_identity_id).push(row.source);
  }
  const sonicAvailable = hasTable(sonicDb, "track_sonic_profile");
  const embedded = new Set();
  if (sonicAvailable) {
    // Bound vector reads without relying on Node 22's SQLite iterator lifetime.
    // Validate the same stored vector contract as coverage; vectors stay in this worker.
    const profiles = sonicDb.prepare("SELECT id, identity_key, embedding_base64 FROM track_sonic_profile WHERE model = ? AND model_version = ? AND dimensions = ? AND id > ? ORDER BY id LIMIT 128");
    let afterId = 0;
    while (true) {
      const rows = profiles.all(MODEL, MODEL_VERSION, DIMENSIONS, afterId);
      for (const row of rows) {
        if (validCoverageEmbedding({ model: MODEL, modelVersion: MODEL_VERSION, dimensions: DIMENSIONS, vector: decodeVector(row.embedding_base64) })) embedded.add(row.identity_key);
      }
      if (rows.length < 128) break;
      afterId = rows[rows.length - 1].id;
    }
  }
  const anchors = new Map(readRows(sonicDb, "sonic_anchor_profile", "SELECT anchor_identity_key, genre, subgenre, mood, tags_json, note FROM sonic_anchor_profile").map(row => [row.anchor_identity_key, row]));
  const reviewed = new Set(readRows(sonicDb, "sonic_review_session_item", "SELECT DISTINCT candidate_identity_key FROM sonic_review_session_item WHERE decision IS NOT NULL AND decision <> ''").map(row => row.candidate_identity_key));
  for (const row of readRows(sonicDb, "sonic_neighbor_feedback", "SELECT DISTINCT candidate_identity_key FROM sonic_neighbor_feedback WHERE rating <> ''")) reviewed.add(row.candidate_identity_key);
  const records = identities.map(row => {
    const providers = [...(enrichments.get(row.id)?.values() || [])];
    providers.sort((a, b) => ({ tidal: 0, beatport: 1, discogs: 2, musicbrainz: 3 }[a.provider] ?? 4) - ({ tidal: 0, beatport: 1, discogs: 2, musicbrainz: 3 }[b.provider] ?? 4));
    const bp = beatport.get(row.id);
    const priority = [bp, ...providers].filter(Boolean);
    const pick = field => priority.map(item => item[field]).find(value => text(value)) || "";
    const tidalId = /^\d+$/.test(text(row.tidal_id)) ? text(row.tidal_id) : "";
    const linkedKeys = [row.identity_key, tidalId ? `tidal:${tidalId}` : ""];
    const visited = new Set();
    let canonicalId = row.id;
    for (let depth = 0; depth < 8 && !visited.has(canonicalId); depth++) {
      visited.add(canonicalId);
      canonicalId = aliases.get(canonicalId);
      if (!canonicalId) break;
      const canonical = identitiesById.get(canonicalId);
      if (canonical) linkedKeys.push(canonical.identity_key);
    }
    // Reuse only persisted exact resolutions, never an artist/title guess.
    const identityKeys = unique([...linkedKeys, ...linkedKeys.map(key => preparedIdentities.get(key))]);
    const anchor = identityKeys.map(key => anchors.get(key)).find(Boolean);
    const genre = priority.map(item => genreValues(item.genre)).find(values => values.length) || [];
    const subgenre = priority.map(item => genreValues(item.subgenre)).find(values => values.length) || [];
    const imageSources = [providers.find(item => item.provider === "tidal"), bp && { ...bp, provider: "beatport" }, ...providers].filter(Boolean);
    const imageSource = imageSources.find(item => artwork(item.raw, item.provider));
    const album = text(row.album) || text(pick("release_title"));
    const tidalRaw = providers.find(item => item.provider === "tidal")?.raw || {};
    const tidalAlbum = typeof tidalRaw.album === "object" ? tidalRaw.album : {};
    const tidalAlbumId = text(tidalAlbum.id || tidalRaw.albumId);
    // A shared, explicitly identified release groups compilations across artists.
    // Without release evidence, retain the artist to avoid merging unrelated albums.
    const albumProvider = providers.find(item => fold(item.release_title) === fold(album) && item.release_id);
    const albumRelease = albumProvider ? `${albumProvider.provider}-album:${albumProvider.release_id}`
      : bp?.release_id && fold(bp.release_title) === fold(album) ? `beatport-album:${bp.release_id}` : "";
    const releaseDate = text(pick("release_date"));
    const year = /^\d{4}/.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : null;
    const record = {
      id: row.id, identityKey: row.identity_key, tidalId, isrc: text(row.isrc),
      artist: text(row.artist), title: text(row.title), mixVersion: text(row.mix_version), album,
      albumKey: album ? (tidalAlbumId && /^\d+$/.test(tidalAlbumId) ? `tidal-album:${tidalAlbumId}` : albumRelease || `album:${fold(album)}|${fold(row.artist)}`) : "",
      genres: unique([...genre, ...subgenre]), label: text(pick("label")),
      bpm: positiveNumber(pick("bpm")), key: text(pick("camelot") || pick("key_name")), year, releaseDate,
      durationMs: positiveNumber(row.duration_ms) || positiveNumber(pick("duration_ms")),
      rating: ratings.get(row.id) || "", tags: unique(providers.flatMap(item => musicalTags(parse(item.tags, [])))),
      sonicTags: unique([...(anchor ? tags(parse(anchor.tags_json, [])) : []), ...tags(anchor?.mood)]),
      sonicEmbedded: sonicAvailable ? identityKeys.some(key => embedded.has(key)) : null,
      sonicIdentityKey: identityKeys.find(key => embedded.has(key)) || "", sonicAnchor: Boolean(anchor),
      sonicReviewed: identityKeys.some(key => reviewed.has(key)), sonicNote: text(anchor?.note),
      imageUrl: imageSource ? artwork(imageSource.raw, imageSource.provider) : "", artworkSource: imageSource?.provider || "",
      providers: unique([...(bp ? ["beatport"] : []), ...providers.map(item => item.provider)]),
      sources: unique(sources.get(row.id) || []), beatportId: text(bp?.beatport_track_id),
      firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, observations: Number(row.observation_count) || 0
    };
    record._browseEvidence = [
      ...(bp ? [{ provider: 'beatport', id: text(bp.beatport_track_id), artist: (bp.raw.artists || []).map(a => a.name).filter(Boolean).join(', '), title: text(bp.raw.name || bp.raw.title), mixVersion: text(bp.raw.mix_name || bp.raw.mixName), durationMs: bp.duration_ms, isrc: bp.isrc }] : []),
      ...providers.filter(p => p.provider === 'tidal').map(p => ({ provider: 'tidal', id: text(p.provider_track_id), artist: text(p.raw.artist), title: text(p.raw.title), mixVersion: text(p.raw.mixVersion || p.raw.version), durationMs: p.duration_ms, isrc: p.isrc }))
    ];
    record._artistCredits = (bp?.raw.artists || []).map(a => a.name).filter(Boolean);
    const matchingAlbumSource = priority.find(item => fold(item.release_title) === fold(album));
    const albumDate = text(matchingAlbumSource?.release_date);
    record.albumYear = /^\d{4}/.test(albumDate) ? Number(albumDate.slice(0, 4)) : null;
    record.albumImage = matchingAlbumSource ? artwork(matchingAlbumSource.raw, matchingAlbumSource === bp ? 'beatport' : matchingAlbumSource.provider) : '';
    if (imageSource) {
      const originalUrl = artwork(imageSource.raw, imageSource.provider, { preferOriginal: false });
      if (record.imageUrl !== originalUrl) record.artworkProjection = { reason: "original-source-before-bridge-cache", originalUrl, snapshotId: imageSource.id, provider: imageSource.provider, providerReleaseId: imageSource.release_id || "" };
      const repair = artworkRepairs.get(`${row.id}|${imageSource.id}|${record.imageUrl}`);
      if (repair && safeImage(repair.replacement_url)) {
        record.artworkProjection = { reason: "exact-provider-track-artwork-refresh", originalUrl: record.imageUrl, snapshotId: repair.snapshot_id, provider: imageSource.provider, repairId: repair.id };
        record.imageUrl = safeImage(repair.replacement_url);
      }
    }
    if (!record.imageUrl) {
      const recovered = require("./artworkPolicy").recoverLegacyArtwork(record, artworkHistory.get(row.id) || [], artwork, safeImage);
      if (recovered) {
        record.imageUrl = recovered.url;
        record.artworkSource = recovered.provider;
        record.artworkRecovery = recovered;
      }
    }
    record.searchText = fold([record.artist, record.title, record.album, record.mixVersion, record.label, ...record.genres, ...record.tags, ...record.sonicTags, record.tidalId, record.beatportId, record.isrc].join(" "));
    return record;
  });
  return { records, sonicAvailable, generatedAt: new Date().toISOString() };
}

const FACETS = { genre: record => record.genres, artist: record => [record.artist], label: record => [record.label], tag: record => record.tags, sonicTag: record => record.sonicTags, rating: record => [record.rating || "unrated"], provider: record => record.providers, source: record => record.sources };
const SINGLE_FILTERS = ["q", "album", "sonic", "artwork", "media", "availability", "yearMin", "yearMax", "bpmMin", "bpmMax", "durationMin", "durationMax"];
function normalizeQuery(input = {}) {
  const getAll = key => input instanceof URLSearchParams ? input.getAll(key) : Array.isArray(input[key]) ? input[key] : input[key] == null ? [] : [input[key]];
  const get = key => input instanceof URLSearchParams ? input.get(key) : input[key];
  const query = Object.fromEntries(Object.keys(FACETS).map(key => [key, unique(getAll(key)).slice(0, 24)]));
  for (const key of SINGLE_FILTERS) query[key] = text(get(key)).slice(0, 300);
  query.view = ["tags", "albums", "tracks", "recordings"].includes(get("view")) ? get("view") : "tags";
  query.group = ["genre", "tag", "sonicTag", "artist", "label"].includes(get("group")) ? get("group") : "genre";
  query.sort = ["name", "artist", "recent", "year", "bpm", "duration", "count"].includes(get("sort")) ? get("sort") : "name";
  query.direction = get("direction") === "desc" ? "desc" : "asc";
  query.limit = Math.max(1, Math.min(100, Math.trunc(Number(get("limit")) || 48)));
  query.offset = Math.max(0, Math.min(1_000_000, Math.trunc(Number(get("offset")) || 0)));
  return query;
}

function matches(record, query, omitFacet = "") {
  if (query.availability && record.availability !== query.availability) return false;
  if (query.q && !fold(query.q).split(/\s+/).every(part => record.searchText.includes(part))) return false;
  for (const [field, getter] of Object.entries(FACETS)) {
    if (field === omitFacet || !query[field].length) continue;
    const actual = getter(record).map(fold);
    // Multiple selections in a facet are OR; different facets combine with AND.
    if (!query[field].some(value => actual.includes(fold(value)))) return false;
  }
  if (query.album && record.albumKey !== query.album && record.albumCollectionKey !== query.album) return false;
  if (query.sonic && record.sonicEmbedded == null) return false;
  if (query.sonic === "embedded" && !record.sonicEmbedded || query.sonic === "missing" && record.sonicEmbedded || query.sonic === "reviewed" && !record.sonicReviewed || query.sonic === "anchor" && !record.sonicAnchor) return false;
  if (query.artwork === "has" && !record.imageUrl || query.artwork === "missing" && record.imageUrl) return false;
  for (const [field, value] of [["year", record.year], ["bpm", record.bpm], ["duration", record.durationMs == null ? null : record.durationMs / 60000]]) {
    for (const [bound, compare] of [["Min", (a, b) => a >= b], ["Max", (a, b) => a <= b]]) {
      const requested = query[field + bound];
      if (requested !== "" && Number.isFinite(Number(requested)) && (value == null || !compare(value, Number(requested)))) return false;
    }
  }
  return true;
}

function compareItems(query, grouped = false) {
  const sign = query.direction === "desc" ? -1 : 1;
  const key = { name: grouped ? "name" : "title", artist: "artist", recent: "lastSeenAt", year: "year", bpm: "bpm", duration: "durationMs", count: "count" }[query.sort];
  return (a, b) => {
    const left = a[key], right = b[key];
    const leftMissing = left == null || left === "", rightMissing = right == null || right === "";
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    const order = typeof left === "number" && typeof right === "number" ? left - right : text(left).localeCompare(text(right), undefined, { numeric: true, sensitivity: "base" });
    return sign * order || text(a.id).localeCompare(text(b.id), undefined, { numeric: true });
  };
}

function groupRecords(records, query, snapshot = {}) {
  const groups = new Map();
  for (const record of records) {
    const values = query.view === "albums" ? (record.albumKey ? [record.albumCollectionKey || record.albumKey] : []) : FACETS[query.group](record).filter(Boolean);
    for (const value of values) {
      const id = query.view === "albums" ? value : fold(value);
      if (!groups.has(id)) groups.set(id, { id, value, name: query.view === "albums" ? record.album : value, artist: record.artist, count: 0, images: [], lastSeenAt: "", year: null });
      const item = groups.get(id);
      item._recordings ||= new Set();
      item._recordings.add(record.recordingKey || record.id);
      item.count = item._recordings.size;
      if (item.artist !== record.artist) item.artist = "Various artists";
      if (record.imageUrl && item.images.length < 4 && !item.images.includes(record.imageUrl)) item.images.push(record.imageUrl);
      if (record.lastSeenAt > item.lastSeenAt) item.lastSeenAt = record.lastSeenAt;
      item.year = Math.max(item.year || 0, record.year || 0) || null;
    }
  }
  return [...groups.values()].map(item => {
    const { _recordings, ...result } = item;
    const collection = query.view === 'albums' && snapshot.albumCollections?.find(c => c.id === item.id);
    return collection ? { ...result, ...collection, count: item.count } : result;
  });
}

function publicRecord(record) {
  const { searchText, _browseEvidence, _artistCredits, ...result } = record;
  return result;
}

function browseCatalog(snapshot, input = {}) {
  const query = normalizeQuery(input);
  if (query.media === 'local') {
    const local = snapshot.localMedia || { records: [], scans: [], sonicAvailable: false };
    const result = browseCatalog({ records: local.records, sonicAvailable: local.sonicAvailable, generatedAt: snapshot.generatedAt }, { ...query, media: '', view: query.view === 'recordings' ? 'tracks' : query.view });
    return { ...result, query, media: 'local', localScans: local.scans, availabilityCounts: Object.fromEntries(['available', 'missing', 'unreadable'].map(status => [status, local.records.filter(r => r.availability === status).length])) };
  }
  if (query.view === 'recordings') return require('./canonicalRecordingCatalog').browseRecordings(snapshot, query);
  const records = query.view === 'tracks' ? snapshot.records : snapshot.browseRecords || snapshot.records;
  const matching = records.filter(record => matches(record, query));
  const facets = {};
  for (const [field, getter] of Object.entries(FACETS)) {
    const counts = new Map();
    for (const record of snapshot.records) {
      if (!matches(record, query, field)) continue;
      for (const value of unique(getter(record)).filter(Boolean)) {
        const key = fold(value);
        const item = counts.get(key) || { value, count: 0 };
        item.count++;
        counts.set(key, item);
      }
    }
    facets[field] = [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
  const items = (query.view === "tracks" ? matching : groupRecords(matching, query, snapshot)).sort(compareItems(query, query.view !== "tracks"));
  const offset = items.length ? Math.min(query.offset, Math.floor((items.length - 1) / query.limit) * query.limit) : 0;
  return {
    enabled: true, view: query.view, group: query.group, query, total: items.length, matchingTracks: matching.length,
    catalogTracks: snapshot.records.length, sonicAvailable: snapshot.sonicAvailable, generatedAt: snapshot.generatedAt,
    offset, limit: query.limit, items: items.slice(offset, offset + query.limit).map(publicRecord), facets,
    missingAlbumCount: matching.filter(record => !record.albumKey).length
  };
}

module.exports = { readCatalog, browseCatalog, normalizeQuery, publicRecord, safeImage, artwork, matches, FACETS, compareItems };
