"use strict";

// Additive, injected catalogue collection. No provider construction, persistence,
// authentication, model, database or playback. Catalogue listings are not charts.
const assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const { normalizeBeatportTrack } = require("./beatportClient");
const { canonicalTrack } = require("./sonicCatalogScoutCollector");
const { coarseCandidateReason } = require("./sonicCatalogScoutCoverageProbe");
const verifiedSource = require("./sonicCatalogVerifiedSource");
const { matcherDiagnostic } = require("../scripts/sonic-catalog-sourcing-diagnostic");
const { recordingGroup } = require("./sonicAnalysisPilot");
const { artistCreditSetKey, normalizeCatalogText, normalizeAlbumFamily, parseCanonicalCatalogIdentity } = require("./catalogIdentityNormalization");
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");
const text = value => typeof value === "string" ? value.trim() : "";
const id = value => typeof value === "string" && /^[1-9]\d*$/.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const numeric = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const isrc = value => text(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
const work = track => artistCreditSetKey(track.artist) + "|" + parseCanonicalCatalogIdentity(track).normalizedBaseTitle;
const GENRES = Object.freeze([
  Object.freeze({ genreId: "91", genreName: "Bass House" }),
  Object.freeze({ genreId: "92", genreName: "Techno (Raw / Deep / Hypnotic)" })
]);
const VERIFIED_COLLECTOR_REQUESTS = Object.freeze(GENRES.flatMap((genre, i) => [1, 2].map(ordinal => Object.freeze({
  requestId: (i ? "raw-techno-" : "bass-house-") + ordinal, ...genre, anchorOrdinal: ordinal
}))));
const VERIFIED_COLLECTOR_RECIPE = Object.freeze({
  kind: "catalog-scout-verified-original-descriptive-fit", providerPages: 6, providerPageNumbers: Object.freeze([2, 3, 4]), maxResultsPerPage: 100,
  maxSourceAttempts: 160, maxSourceAttemptsPerGenre: 80, maxTidalQueriesPerSource: 3,
  maxTidalResultsPerQuery: 20, maxTidalDetailsPerSource: 3, maxSources: 16,
  maxCandidatesPerRequest: 6, scoutCount: 6, finalCount: 3, agreementWeight: 0,
  distinctReleasesPerGenre: 8, distinctCanonicalAlbumsPerGenre: 8,
  nonoverlappingArtistIdsPerGenre: true, releasedOnly: true, productionApplied: false
});
function validateVerifiedCollectorRequest(request) {
  assert.equal(request?.version, 1);
  for (const [key, value] of Object.entries(VERIFIED_COLLECTOR_RECIPE)) assert.deepEqual(request.recipe?.[key], value, "Declared verified recipe changed: " + key);
  assert.deepEqual(request.requests, VERIFIED_COLLECTOR_REQUESTS);
  for (const key of ["excludedBeatportTrackIds", "excluded", "heldOut", "excludedSourceSha256"]) assert.ok(Array.isArray(request[key]), "Declare exclusions: " + key);
  assert.ok(request.excludedBeatportTrackIds.length <= 10000 && request.excludedBeatportTrackIds.every(id));
  assert.ok(request.excluded.length <= 10000 && request.heldOut.length === 6);
  assert.ok([...request.excluded, ...request.heldOut].every(track => text(track?.identityKey) && text(track.artist) && text(track.title)));
  assert.ok(request.excludedSourceSha256.length <= 10000 && request.excludedSourceSha256.every(sha));
  return VERIFIED_COLLECTOR_RECIPE;
}
function frozenRow(row, genre, cutoffDate) {
  assert.ok(row && id(row.id) && row.genreId === genre.genreId && row.genre === genre.genreName);
  assert.ok(text(row.artist) && text(row.title) && id(row.releaseId) && text(row.album));
  assert.ok(Array.isArray(row.artistIds) && row.artistIds.length && row.artistIds.every(id) && new Set(row.artistIds).size === row.artistIds.length);
  assert.match(row.releaseDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(Date.parse(row.releaseDate)) && new Date(row.releaseDate + "T00:00:00Z").toISOString().slice(0, 10) === row.releaseDate && row.releaseDate <= cutoffDate);
  const { catalogRecordKey, ...body } = row;
  assert.equal(catalogRecordKey, hash(JSON.stringify(body)), "Frozen catalogue row changed.");
  assert.ok(!Object.keys(row).some(key => /url|token|rawjson/i.test(key)), "Catalogue locators remain transient.");
  return row;
}
function catalogueRow(input, genre, cutoffDate) {
  const raw = input?.rawJson;
  assert.ok(raw && typeof raw === "object" && !Array.isArray(raw));
  const actualGenre = raw.genre || raw.attributes?.genre;
  assert.ok(String(actualGenre?.id) === genre.genreId && normalizeCatalogText(actualGenre?.name) === normalizeCatalogText(genre.genreName));
  const normalized = normalizeBeatportTrack(raw);
  assert.ok(id(normalized.id) && String(input.id) === normalized.id && normalized.genre === genre.genreName);
  const attributes = { ...(raw.attributes || {}), ...raw };
  assert.ok([attributes.id, attributes.track_id, input.beatportTrackId].filter(value => value !== undefined && value !== "").every(value => String(value) === normalized.id));
  assert.equal(artistCreditSetKey(input.artist), artistCreditSetKey(normalized.artist));
  const row = { id: normalized.id, artist: normalized.artist, title: normalized.title,
    genreId: genre.genreId, genre: normalized.genre, artistIds: normalized.artistIds,
    releaseId: normalized.releaseId, album: normalized.album, releaseDate: text(normalized.releaseDate).slice(0, 10) };
  for (const key of ["mixName", "isrc", "label", "subGenre", "bpm", "durationMs"]) if (normalized[key] !== undefined && normalized[key] !== null && normalized[key] !== "") row[key] = clone(normalized[key]);
  row.catalogRecordKey = hash(JSON.stringify(row));
  return { row: frozenRow(row, genre, cutoffDate), previewUrl: normalized.previewUrl };
}
function requestedTrack(row) {
  return { artist: row.artist, title: row.title, mixVersion: row.mixName || "", beatportTrackId: row.id,
    ...Object.fromEntries(["album", "isrc", "label", "durationMs", "releaseDate"].filter(key => row[key] !== undefined).map(key => [key, row[key]])) };
}
function sameRecording(left, right) {
  return left.identityKey === right.identityKey || recordingGroup(left) === recordingGroup(right) || work(left) === work(right)
    || isrc(left.isrc) && isrc(left.isrc) === isrc(right.isrc);
}
function increment(counts, reason) { counts[reason] = (counts[reason] || 0) + 1; }
function roundRobinReleaseRows(pages, request) {
  const records = new Map(), conflicts = new Set(pages.flatMap(page => page.conflictingTrackIds || []));
  for (const page of pages) for (const row of page.rows) {
    const previous = records.get(row.id);
    if (previous && previous.row.catalogRecordKey !== row.catalogRecordKey) conflicts.add(row.id);
    else if (!previous) records.set(row.id, { row, pageKey: page.pageKey });
  }
  const releases = new Map();
  for (const item of records.values()) if (!conflicts.has(item.row.id) && !request.excludedBeatportTrackIds.includes(item.row.id)) {
    if (!releases.has(item.row.releaseId)) releases.set(item.row.releaseId, []);
    releases.get(item.row.releaseId).push(item);
  }
  const groups = [...releases].sort(([a], [b]) => numeric(a, b)).map(([, rows]) => rows.sort((a, b) => numeric(a.row.id, b.row.id)));
  const ordered = [];
  for (let round = 0; groups.some(rows => rows[round]); round++) for (const rows of groups) if (rows[round]) ordered.push(rows[round]);
  return { ordered, conflictingTrackIds: [...conflicts].sort(numeric) };
}
function validateVerifiedCollectionBreadth(progress, { requireComplete = true } = {}) {
  assert.ok(progress && Array.isArray(progress.entries) && Array.isArray(progress.catalogProvenance) && Array.isArray(progress.breadth) && Array.isArray(progress.genres));
  assert.equal(progress.catalogProvenance.length, progress.entries.length); assert.equal(progress.breadth.length, progress.entries.length);
  assert.equal(progress.genres.length, 2); assert.ok(progress.entries.length <= 16);
  assert.equal(new Set(progress.entries.map(entry => entry.track.identityKey)).size, progress.entries.length);
  const identities = new Set(), releasesByGenre = new Map(), albumsByGenre = new Map(), artistsByGenre = new Map();
  for (const [index, genre] of progress.genres.entries()) {
    assert.equal(genre.genreId, GENRES[index].genreId); assert.equal(genre.genreName, GENRES[index].genreName);
    assert.ok(Array.isArray(genre.anchorIdentityKeys) && genre.anchorIdentityKeys.length <= 2 && Array.isArray(genre.candidateIdentityKeys) && genre.candidateIdentityKeys.length <= 6);
    const keys = [...genre.anchorIdentityKeys, ...genre.candidateIdentityKeys]; assert.equal(new Set(keys).size, keys.length);
    releasesByGenre.set(genre.genreId, new Set()); albumsByGenre.set(genre.genreId, new Set()); artistsByGenre.set(genre.genreId, new Set());
    for (const key of keys) { assert.ok(!identities.has(key)); identities.add(key); }
  }
  for (const entry of progress.entries) {
    const proofs = progress.catalogProvenance.filter(row => row.identityKey === entry.track.identityKey), breadth = progress.breadth.filter(row => row.identityKey === entry.track.identityKey);
    assert.equal(proofs.length, 1); assert.equal(breadth.length, 1);
    const proof = proofs[0], record = breadth[0], genre = progress.genres.find(row => row.genreId === proof.genreId);
    assert.ok(genre && [...genre.anchorIdentityKeys, ...genre.candidateIdentityKeys].includes(entry.track.identityKey));
    verifiedSource.assertSonicSourceSnapshot(entry.source, { track: entry.track });
    assert.equal(proof.beatportTrackId, entry.source.sourceTrackId); assert.equal(proof.sourceSnapshotKey, entry.source.snapshotKey);
    assert.equal(proof.genreName, genre.genreName); assert.equal(entry.metadata.beatportGenre, genre.genreName);
    assert.equal(record.genreId, genre.genreId); assert.equal(record.beatportTrackId, proof.beatportTrackId); assert.equal(record.sourceSnapshotKey, proof.sourceSnapshotKey);
    assert.ok(id(record.beatportReleaseId) && text(record.beatportAlbum)); assert.equal(record.beatportAlbum, entry.source.sourceTrack.album);
    assert.equal(record.canonicalAlbumFamily, normalizeAlbumFamily(entry.track.album)); assert.ok(text(record.canonicalAlbumFamily));
    assert.deepEqual(record.artistIds, proof.artistIds); assert.ok(record.artistIds.length && record.artistIds.every(id));
    const releaseIds = releasesByGenre.get(genre.genreId), albums = albumsByGenre.get(genre.genreId), artistIds = artistsByGenre.get(genre.genreId);
    assert.ok(!releaseIds.has(record.beatportReleaseId), "Repeated accepted Beatport release."); releaseIds.add(record.beatportReleaseId);
    assert.ok(!albums.has(record.canonicalAlbumFamily), "Repeated canonical album family."); albums.add(record.canonicalAlbumFamily);
    for (const artistId of record.artistIds) { assert.ok(!artistIds.has(artistId), "Overlapping accepted artist identity."); artistIds.add(artistId); }
    const owners = progress.pages.filter(page => page.pageKey === proof.pageKey && page.genreId === proof.genreId)
      .flatMap(page => page.rows.filter(row => row.id === proof.beatportTrackId).map(row => ({ page, row })));
    assert.equal(owners.length, 1, "Every source needs one frozen catalogue owner.");
    const { page, row } = owners[0];
    assert.ok([2, 3, 4].includes(page.page) && page.pageKey === genre.genreId + ":catalogue:" + page.page && page.feed === "catalogue"
      && page.perPage === 100 && page.maxPages === 1 && page.status === "ready", "Source catalogue page changed.");
    frozenRow(row, genre, progress.cutoffDate);
    assert.equal(row.releaseId, record.beatportReleaseId); assert.equal(row.album, record.beatportAlbum); assert.deepEqual(row.artistIds, proof.artistIds);
    for (const [key, value] of Object.entries(entry.source.sourceTrack)) assert.deepEqual(row[key], value, "Frozen source recording diverged from catalogue metadata.");
  }
  assert.equal(identities.size, progress.entries.length);
  const complete = progress.entries.length === 16 && progress.genres.every(genre => genre.anchorIdentityKeys.length === 2 && genre.candidateIdentityKeys.length === 6);
  if (requireComplete) assert.equal(complete, true, "Both genres require eight distinct releases, albums and artist sets.");
  return { complete, genres: progress.genres.map(genre => ({ genreId: genre.genreId, anchors: genre.anchorIdentityKeys.length, candidates: genre.candidateIdentityKeys.length,
    distinctBeatportReleases: releasesByGenre.get(genre.genreId).size, distinctCanonicalAlbums: albumsByGenre.get(genre.genreId).size, distinctArtistIds: artistsByGenre.get(genre.genreId).size })) };
}
function validateProgress(progress, request, requestSha256) {
  assert.equal(progress.version, 1); assert.equal(progress.kind, VERIFIED_COLLECTOR_RECIPE.kind); assert.equal(progress.requestSha256, requestSha256);
  assert.match(progress.cutoffDate, /^\d{4}-\d{2}-\d{2}$/);
  for (const key of ["pages", "attempts", "entries", "catalogProvenance", "breadth", "genres"]) assert.ok(Array.isArray(progress[key]));
  assert.ok(progress.pages.length <= 6 && progress.attempts.length <= 160 && progress.entries.length <= 16);
  assert.equal(new Set(progress.pages.map(page => page.pageKey)).size, progress.pages.length);
  for (const page of progress.pages) {
    const genre = GENRES.find(row => row.genreId === page.genreId);
    assert.ok(genre && page.feed === "catalogue" && [2, 3, 4].includes(page.page) && page.pageKey === genre.genreId + ":catalogue:" + page.page && page.perPage === 100 && page.maxPages === 1);
    assert.ok(["started", "ready", "unavailable"].includes(page.status) && Array.isArray(page.rows) && page.rows.length <= 100);
    assert.ok(Array.isArray(page.conflictingTrackIds || []) && (page.conflictingTrackIds || []).every(id));
    for (const row of page.rows) frozenRow(row, genre, progress.cutoffDate);
    assert.equal(new Set(page.rows.map(row => row.id)).size, page.rows.length);
  }
  assert.equal(new Set(progress.attempts.map(attempt => attempt.beatportTrackId)).size, progress.attempts.length);
  for (const attempt of progress.attempts) {
    assert.ok(id(attempt.beatportTrackId) && !request.excludedBeatportTrackIds.includes(attempt.beatportTrackId));
    assert.ok(GENRES.some(genre => genre.genreId === attempt.genreId) && ["anchor", "candidate"].includes(attempt.role));
    assert.ok(["started", "frozen-exact", "frozen-verified", "unavailable", "excluded"].includes(attempt.status));
    assert.ok((attempt.tidalQueries || []).length <= 3 && (attempt.canonicalLookups || []).length <= 3);
    assert.ok(progress.pages.some(page => page.pageKey === attempt.pageKey && page.genreId === attempt.genreId && page.rows.some(row => row.id === attempt.beatportTrackId)));
    if (["frozen-exact", "frozen-verified"].includes(attempt.status)) assert.ok(progress.entries.some(entry => entry.track.identityKey === attempt.identityKey
      && entry.source.version === (attempt.status === "frozen-exact" ? 1 : 2)));
  }
  for (const genre of GENRES) assert.ok(progress.attempts.filter(attempt => attempt.genreId === genre.genreId).length <= 80);
  const seen = [];
  for (const entry of progress.entries) {
    assert.equal(entry.verification?.provider, "tidal"); assert.equal(entry.verification.verified, true);
    assert.equal(entry.verification.identityKey, entry.track.identityKey); assert.deepEqual(entry.verification.canonicalTrack, entry.track);
    assert.ok(![...request.excluded, ...request.heldOut, ...seen.map(row => row.track)].some(old => sameRecording(old, entry.track)));
    assert.ok(!request.excludedSourceSha256.includes(entry.source.sourceSha256) && !seen.some(old => old.source.sourceSha256 === entry.source.sourceSha256));
    seen.push(entry);
  }
  validateVerifiedCollectionBreadth(progress, { requireComplete: false });
}
function poolFor(progress) {
  if (!progress.complete) return null;
  const requests = VERIFIED_COLLECTOR_REQUESTS.map(spec => {
    const genre = progress.genres.find(row => row.genreId === spec.genreId), key = genre.anchorIdentityKeys[spec.anchorOrdinal - 1];
    const anchor = progress.entries.find(entry => entry.track.identityKey === key);
    return { requestId: spec.requestId, anchorIdentityKey: key, candidateIdentityKeys: clone(genre.candidateIdentityKeys),
      options: { scoringMode: "similar", request: "Find tracks like " + anchor.track.artist + " — " + anchor.track.title,
        anchorTrack: clone(anchor.track), count: 3, allowPreviousSuggestions: false, allowPreviousFallback: false } };
  });
  return { version: 1, kind: "catalog-scout-pilot-pool", samplingScope: "two-genre", entries: clone(progress.entries), requests, catalogProvenance: clone(progress.catalogProvenance) };
}
async function collectSonicCatalogVerifiedPool({ request, requestSha256, progress: supplied = null, beatport, tidal,
  saveAudio, probeDuration, persistProgress, now = () => new Date().toISOString() } = {}) {
  validateVerifiedCollectorRequest(request); assert.ok(sha(requestSha256));
  for (const dependency of [beatport?.pagedTracks, beatport?.fetchPreviewBuffer, tidal?.searchTracks, tidal?.getTrack, saveAudio, probeDuration, persistProgress, now]) assert.equal(typeof dependency, "function");
  const cutoffDate = text(now()).slice(0, 10);
  const progress = supplied ? clone(supplied) : { version: 1, kind: VERIFIED_COLLECTOR_RECIPE.kind, requestSha256,
    cutoffDate, cataloguePolicy: "six fixed plain catalogue pages 2/3/4; deterministic release round-robin", pages: [], attempts: [], entries: [], catalogProvenance: [], breadth: [],
    genres: GENRES.map(genre => ({ ...genre, anchorIdentityKeys: [], candidateIdentityKeys: [] })) };
  validateProgress(progress, request, requestSha256);
  if (supplied) {
    assert.equal(progress.closed, true, "Interrupted collections stay closed to provider retries; declare a separate run.");
    assert.equal(progress.complete, validateVerifiedCollectionBreadth(progress, { requireComplete: false }).complete);
    return { progress, complete: progress.complete, pool: poolFor(progress) };
  }
  const mark = () => persistProgress(clone(progress)), previews = new Map();
  for (const genre of GENRES) for (const pageNumber of [2, 3, 4]) {
    const page = { pageKey: genre.genreId + ":catalogue:" + pageNumber, ...genre, feed: "catalogue", page: pageNumber, perPage: 100, maxPages: 1, status: "started", at: now(), rows: [], rejected: {} };
    progress.pages.push(page); await mark();
    let response;
    try { response = await beatport.pagedTracks("/catalog/tracks/", { params: { genre_id: genre.genreId }, page: pageNumber, perPage: 100, maxPages: 1 }); assert.ok(Array.isArray(response?.tracks)); }
    catch { page.status = "unavailable"; page.stage = "metadata"; page.reason = "catalogue-page-unavailable"; await mark(); continue; }
    const rows = new Map(), conflicts = new Set();
    for (const input of response.tracks.slice(0, 100)) {
      try { const frozen = catalogueRow(input, genre, progress.cutoffDate), previous = rows.get(frozen.row.id);
        if (previous && previous.catalogRecordKey !== frozen.row.catalogRecordKey) conflicts.add(frozen.row.id);
        else if (!previous) { rows.set(frozen.row.id, frozen.row); previews.set(page.pageKey + "|" + frozen.row.id, frozen.previewUrl); } }
      catch { increment(page.rejected, "malformed-wrong-genre-or-unreleased-row"); }
    }
    for (const conflictingId of conflicts) { rows.delete(conflictingId); previews.delete(page.pageKey + "|" + conflictingId); increment(page.rejected, "conflicting-catalogue-identity"); }
    page.conflictingTrackIds = [...conflicts].sort(numeric); page.rows = [...rows.values()].sort((a, b) => numeric(a.id, b.id)); page.status = "ready"; await mark();
  }
  assert.equal(progress.pages.length, 6);
  async function reject(attempt, stage, reason, status = "unavailable") {
    attempt.status = status; attempt.stage = stage; attempt.reason = reason; await mark(); return null;
  }
  async function resolve(row, attempt) {
    const requested = requestedTrack(row), baseTitle = parseCanonicalCatalogIdentity(requested).normalizedBaseTitle;
    const queries = [...new Set([[row.artist, row.title, row.mixName], [row.artist, baseTitle], [baseTitle, row.mixName]].map(parts => parts.filter(Boolean).join(" ")).filter(Boolean))].slice(0, 3);
    const examined = new Set(); attempt.tidalQueries = []; attempt.canonicalLookups = [];
    for (const query of queries) {
      if (attempt.canonicalLookups.length === 3) break;
      const search = { query, pageCount: 1, limit: 20, status: "started", candidateCount: 0, coarseRejections: {} };
      attempt.tidalQueries.push(search); await mark(); let rows;
      try { rows = await tidal.searchTracks(query, { limit: 20, detailLimit: 0, fullPage: false, pageCount: 1, rotateCatalog: false }); assert.ok(Array.isArray(rows)); }
      catch { search.status = "unavailable"; search.stage = "identity"; search.reason = "canonical-search-unavailable"; await mark(); continue; }
      search.status = "complete"; const eligible = [];
      for (const result of rows.slice(0, 20)) {
        search.candidateCount++;
        try { const candidate = canonicalTrack(result), reason = coarseCandidateReason(requested, candidate);
          if (reason) { increment(search.coarseRejections, reason); continue; }
          if (!examined.has(candidate.tidalId)) { examined.add(candidate.tidalId); eligible.push(candidate); }
        } catch { increment(search.coarseRejections, "malformed-tidal-identity"); }
      }
      await mark(); eligible.sort((a, b) => numeric(a.tidalId, b.tidalId));
      for (const candidate of eligible) {
        if (attempt.canonicalLookups.length === 3) break;
        const lookup = { tidalId: candidate.tidalId, status: "started" }; attempt.canonicalLookups.push(lookup); await mark(); let track;
        try { track = canonicalTrack(await tidal.getTrack(candidate.tidalId, query)); assert.equal(track.tidalId, candidate.tidalId); }
        catch { lookup.status = "unverified"; lookup.stage = "detail"; lookup.reason = "canonical-detail-unavailable-or-identity-conflict"; await mark(); continue; }
        const coarse = coarseCandidateReason(requested, track);
        let admission;
        try { lookup.diagnostic = matcherDiagnostic(requested, track, row); admission = verifiedSource.admissionFor(track, row); }
        catch { admission = null; }
        if (admission) lookup.admission = clone(Object.fromEntries(["accepted", "reason", "version", "identityRelation", "proof"].map(key => [key, admission[key]])));
        if (coarse || !lookup.diagnostic?.tidal.matched || !lookup.diagnostic?.beatport.matched || !admission?.accepted) {
          lookup.status = "unverified"; lookup.stage = "identity";
          lookup.reason = coarse || (!lookup.diagnostic?.tidal.matched ? "canonical-identity-matcher-rejected" : !lookup.diagnostic?.beatport.matched ? "canonical-source-version-matcher-rejected" : admission?.reason) || "strict-canonical-identity-or-version-rejected";
          await mark(); continue;
        }
        lookup.status = "verified"; await mark(); return track;
      }
    }
    return null;
  }
  for (const state of progress.genres) {
    const ordered = roundRobinReleaseRows(progress.pages.filter(page => page.genreId === state.genreId && page.status === "ready"), request);
    state.conflictingTrackIds = ordered.conflictingTrackIds; state.breadthRejections = {}; await mark();
    for (const { row, pageKey } of ordered.ordered) {
      if (state.anchorIdentityKeys.length + state.candidateIdentityKeys.length === 8 || progress.entries.length === 16 || progress.attempts.length === 160 || progress.attempts.filter(attempt => attempt.genreId === state.genreId).length === 80) break;
      if (progress.attempts.some(attempt => attempt.beatportTrackId === row.id)) continue;
      const accepted = progress.breadth.filter(record => record.genreId === state.genreId);
      if (accepted.some(record => record.beatportReleaseId === row.releaseId)) { increment(state.breadthRejections, "accepted-release-overlap"); continue; }
      if (accepted.some(record => record.artistIds.some(artistId => row.artistIds.includes(artistId)))) { increment(state.breadthRejections, "accepted-artist-id-overlap"); continue; }
      const role = state.anchorIdentityKeys.length < 2 ? "anchor" : "candidate", attempt = { beatportTrackId: row.id, genreId: state.genreId, pageKey,
        requestId: (state.genreId === "91" ? "bass-house-" : "raw-techno-") + (role === "anchor" ? state.anchorIdentityKeys.length + 1 : 1), role, status: "started", stage: "identity", at: now() };
      progress.attempts.push(attempt); await mark();
      const track = await resolve(row, attempt);
      if (!track) { const detailFailure = attempt.canonicalLookups.length > 0 && attempt.canonicalLookups.every(lookup => lookup.stage === "detail");
        await reject(attempt, detailFailure ? "detail" : "identity", detailFailure ? "canonical-details-unavailable-or-conflicting" : "no-exact-canonical-recording"); continue; }
      if ([...request.excluded, ...request.heldOut].some(old => sameRecording(old, track))) { await reject(attempt, "identity", "exposed-or-heldout-recording", "excluded"); continue; }
      if (progress.entries.some(old => sameRecording(old.track, track))) { await reject(attempt, "identity", "duplicate-recording", "excluded"); continue; }
      const canonicalAlbumFamily = normalizeAlbumFamily(track.album);
      if (!canonicalAlbumFamily || accepted.some(record => record.canonicalAlbumFamily === canonicalAlbumFamily)) { await reject(attempt, "identity", canonicalAlbumFamily ? "accepted-canonical-album-overlap" : "canonical-album-unavailable", "excluded"); continue; }
      let bytes; attempt.stage = "preview"; await mark();
      try { const fetched = await beatport.fetchPreviewBuffer({ ...row, previewUrl: previews.get(pageKey + "|" + row.id) || "" }, { maxBytes: 20 * 1024 * 1024 });
        bytes = fetched?.buffer instanceof Uint8Array ? fetched.buffer : fetched; assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 20 * 1024 * 1024); }
      catch { await reject(attempt, "preview", "exact-preview-unavailable"); continue; }
      const sourceSha256 = hash(bytes);
      if (request.excludedSourceSha256.includes(sourceSha256) || progress.entries.some(old => old.source.sourceSha256 === sourceSha256)) { await reject(attempt, "preview", "excluded-or-duplicate-source", "excluded"); continue; }
      let sourceFile; attempt.stage = "freeze"; await mark();
      try { sourceFile = await saveAudio(bytes, { sourceSha256, identityKey: track.identityKey, beatportTrackId: row.id }); assert.ok(text(sourceFile)); }
      catch { await reject(attempt, "freeze", "source-storage-unavailable"); continue; }
      let durationSeconds; attempt.stage = "probe"; await mark();
      try { durationSeconds = await probeDuration(sourceFile); assert.ok(Number.isFinite(durationSeconds) && durationSeconds >= 30 && durationSeconds <= 7200); }
      catch { await reject(attempt, "probe", "preview-duration-unavailable-or-insufficient"); continue; }
      let source; attempt.stage = "freeze"; await mark();
      try { assert.equal(hash(bytes), sourceSha256); source = verifiedSource.freezeSonicSourceSnapshot({ track, sourceType: "beatport-preview", audioBytes: bytes, durationSeconds, sourceTrack: row, allowVersionProxy: false }); verifiedSource.assertSonicSourceSnapshot(source, { track, audioBytes: bytes }); }
      catch { await reject(attempt, "freeze", "exact-source-snapshot-rejected"); continue; }
      const metadata = { query: "Beatport genre " + state.genreId + " catalogue page " + pageKey.split(":")[2], discoverySource: "verified Beatport genre catalogue resolved to canonical TIDAL", discoveryLane: "core", beatportGenre: row.genre };
      if (text(row.subGenre)) metadata.beatportSubgenre = row.subGenre; if (text(row.label)) metadata.label = row.label; if (Number.isFinite(row.bpm) && row.bpm > 0) metadata.bpm = row.bpm;
      const entry = { track, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: clone(track) }, source, sourceFile, metadata };
      progress.entries.push(entry); progress.catalogProvenance.push({ identityKey: track.identityKey, beatportTrackId: row.id, sourceSnapshotKey: source.snapshotKey, genreId: row.genreId, genreName: row.genre, artistIds: clone(row.artistIds), pageKey });
      progress.breadth.push({ identityKey: track.identityKey, beatportTrackId: row.id, sourceSnapshotKey: source.snapshotKey, genreId: row.genreId, beatportReleaseId: row.releaseId, beatportAlbum: row.album, canonicalAlbumFamily, artistIds: clone(row.artistIds) });
      (role === "anchor" ? state.anchorIdentityKeys : state.candidateIdentityKeys).push(track.identityKey);
      attempt.status = source.version === 1 ? "frozen-exact" : "frozen-verified"; attempt.stage = "complete"; attempt.identityKey = track.identityKey; await mark();
    }
  }
  progress.complete = validateVerifiedCollectionBreadth(progress, { requireComplete: false }).complete;
  progress.closed = true; validateProgress(progress, request, requestSha256); await mark();
  return { progress, complete: progress.complete, pool: poolFor(progress) };
}
module.exports = { VERIFIED_COLLECTOR_RECIPE, VERIFIED_COLLECTOR_REQUESTS, validateVerifiedCollectorRequest,
  validateVerifiedCollectionBreadth, collectSonicCatalogVerifiedPool };
