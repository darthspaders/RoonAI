"use strict";

// Bounded catalogue collection with injected providers and private persistence.
// No provider construction, database, authentication, inference or playback.
const assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const { normalizeBeatportTrack } = require("./beatportClient");
const { canonicalTrack } = require("./sonicCatalogScoutCollector");
const { freezeSonicSourceSnapshot, assertSonicSourceSnapshot } = require("./sonicCandidateCorpus");
const { scoreTidalIdentity } = require("./exactTrackVerification");
const { matchBeatportVersionToTidal } = require("./beatportVersionMatch");
const { recordingGroup } = require("./sonicAnalysisPilot");
const { artistCreditSetKey, normalizeCatalogText, parseCanonicalCatalogIdentity } = require("./catalogIdentityNormalization");
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");
const text = value => typeof value === "string" ? value.trim() : "";
const isId = value => typeof value === "string" && /^[1-9]\d*$/.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isrc = value => text(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
const artist = track => artistCreditSetKey(track.artist);
const work = track => artist(track) + "|" + parseCanonicalCatalogIdentity(track).normalizedBaseTitle;
const GENRES = Object.freeze([
  Object.freeze({ genreId: "91", genreName: "Bass House" }),
  Object.freeze({ genreId: "92", genreName: "Techno (Raw / Deep / Hypnotic)" })
]);
const COVERAGE_PROBE_REQUESTS = Object.freeze(GENRES.flatMap((genre, index) => [1, 2].map(ordinal => Object.freeze({
  requestId: (index ? "raw-techno-" : "bass-house-") + ordinal, ...genre, anchorOrdinal: ordinal
}))));
const COVERAGE_PROBE_RECIPE = Object.freeze({
  kind: "catalog-scout-genre-coverage-probe", providerPages: 4, maxResultsPerPage: 36,
  maxSourceAttempts: 96, maxSourceAttemptsPerGenre: 48, maxAnchorAttempts: 18, maxCandidateAttempts: 36,
  maxTidalQueriesPerSource: 3, maxTidalResultsPerQuery: 12, maxTidalDetailsPerSource: 3,
  maxSources: 16, maxCandidatesPerRequest: 6, scoutCount: 6, finalCount: 3, agreementWeight: 0,
  productionApplied: false
});
function validateCoverageProbeRequest(request) {
  assert.equal(request?.version, 1);
  for (const [key, value] of Object.entries(COVERAGE_PROBE_RECIPE)) assert.equal(request.recipe?.[key], value, "The predeclared coverage recipe changed: " + key);
  assert.deepEqual(request.requests, COVERAGE_PROBE_REQUESTS, "Four fixed catalogue-genre requests are required.");
  for (const key of ["excludedBeatportTrackIds", "excluded", "heldOut", "excludedSourceSha256"]) assert.ok(Array.isArray(request[key]), "Declare coverage exclusions: " + key);
  assert.ok(request.excludedBeatportTrackIds.length <= 10000 && request.excludedBeatportTrackIds.every(isId));
  assert.ok(request.excluded.length <= 10000 && request.heldOut.length === 6);
  assert.ok([...request.excluded, ...request.heldOut].every(track => text(track?.identityKey) && text(track.artist) && text(track.title)));
  assert.ok(request.excludedSourceSha256.length <= 10000 && request.excludedSourceSha256.every(sha));
  return COVERAGE_PROBE_RECIPE;
}
function coarseCandidateReason(requested, candidate) {
  if (!artist(requested) || artist(requested) !== artist(candidate)) return "artist-credit-conflict";
  const left = parseCanonicalCatalogIdentity(requested), right = parseCanonicalCatalogIdentity(candidate);
  if (!left.normalizedBaseTitle || left.normalizedBaseTitle !== right.normalizedBaseTitle) return "base-title-conflict";
  const titleVersion = parseCanonicalCatalogIdentity({ title: candidate.title });
  if (right.versionKind !== "none" && titleVersion.versionKind !== "none" && right.normalizedVersion !== titleVersion.normalizedVersion) return "version-conflict";
  if (left.versionKind !== "none" && right.versionKind !== "none" && left.normalizedVersion !== right.normalizedVersion) return "version-conflict";
  if (isrc(requested.isrc) && isrc(candidate.isrc) && isrc(requested.isrc) !== isrc(candidate.isrc)) return "isrc-conflict";
  return null; // Missing search evidence is completed by bounded canonical detail.
}
function savedRow(row, genre) {
  assert.ok(row && isId(row.id) && row.genreId === genre.genreId && row.genre === genre.genreName && text(row.artist) && text(row.title));
  assert.ok(Array.isArray(row.artistIds) && row.artistIds.length && row.artistIds.every(isId));
  const { catalogRecordKey, ...body } = row;
  assert.equal(catalogRecordKey, hash(JSON.stringify(body)), "Frozen catalogue row changed.");
  return row;
}
function catalogueRow(input, genre) {
  const raw = input?.rawJson;
  assert.ok(raw && typeof raw === "object" && !Array.isArray(raw), "Actual Beatport catalogue metadata is required.");
  const rawGenre = raw.genre || raw.attributes?.genre;
  assert.ok(rawGenre && String(rawGenre.id) === genre.genreId && normalizeCatalogText(rawGenre.name) === normalizeCatalogText(genre.genreName), "Wrong actual catalogue genre.");
  const normalized = normalizeBeatportTrack(raw);
  assert.ok(isId(normalized.id) && String(input.id) === normalized.id && normalized.genre === genre.genreName);
  const attributes = { ...(raw.attributes || {}), ...raw };
  assert.ok([attributes.id, attributes.track_id, input.beatportTrackId].filter(value => value !== undefined && value !== "")
    .every(value => String(value) === normalized.id), "Conflicting catalogue source identity.");
  assert.equal(artist(normalized), artist(input), "Conflicting catalogue artist credits.");
  assert.ok(normalized.artistIds.length && normalized.artistIds.every(isId), "Actual numeric artist identity is required.");
  const row = { id: normalized.id, artist: normalized.artist, title: normalized.title, genreId: genre.genreId,
    genre: normalized.genre, artistIds: normalized.artistIds };
  for (const key of ["mixName", "album", "isrc", "label", "subGenre", "bpm", "releaseDate", "year", "durationMs", "previewUrl"]) {
    if (normalized[key] !== undefined && normalized[key] !== null && normalized[key] !== "") row[key] = clone(normalized[key]);
  }
  row.catalogRecordKey = hash(JSON.stringify(row)); return savedRow(row, genre);
}
function requestedTrack(row) {
  return { artist: row.artist, title: row.title, mixVersion: row.mixName || "", beatportTrackId: row.id,
    ...Object.fromEntries(["album", "isrc", "label", "durationMs", "releaseDate", "year"].filter(key => row[key] !== undefined).map(key => [key, row[key]])) };
}
function excludedTrack(track, request) {
  return [...request.excluded, ...request.heldOut].some(old => old.identityKey === track.identityKey
    || isrc(old.isrc) && isrc(old.isrc) === isrc(track.isrc) || recordingGroup(old) === recordingGroup(track) || work(old) === work(track));
}
function duplicate(entry, others) {
  return others.some(old => old.track.identityKey === entry.track.identityKey || old.source.sourceSha256 === entry.source.sourceSha256
    || recordingGroup(old.track) === recordingGroup(entry.track) || work(old.track) === work(entry.track)
    || isrc(entry.track.isrc) && isrc(entry.track.isrc) === isrc(old.track.isrc));
}
function bump(counts, reason) { counts[reason] = (counts[reason] || 0) + 1; }

async function collectSonicCatalogScoutCoverageProbe({ request, requestSha256, progress: supplied = null,
  beatport, tidal, saveAudio, probeDuration, persistProgress, now = () => new Date().toISOString() } = {}) {
  validateCoverageProbeRequest(request); assert.ok(sha(requestSha256));
  for (const dependency of [beatport?.getTrackFeed, beatport?.fetchPreviewBuffer, tidal?.searchTracks, tidal?.getTrack,
    saveAudio, probeDuration, persistProgress, now]) assert.equal(typeof dependency, "function", "Inject every bounded coverage dependency.");
  const progress = supplied ? clone(supplied) : { version: 1, kind: "catalog-scout-genre-coverage-probe", requestSha256,
    pages: [], attempts: [], entries: [], catalogProvenance: [], genres: GENRES.map(g => ({ ...g, anchorIdentityKeys: [], candidateIdentityKeys: [] })) };
  assert.equal(progress.version, 1); assert.equal(progress.kind, "catalog-scout-genre-coverage-probe"); assert.equal(progress.requestSha256, requestSha256);
  for (const key of ["pages", "attempts", "entries", "catalogProvenance", "genres"]) assert.ok(Array.isArray(progress[key]));
  assert.ok(progress.pages.length <= 4 && progress.attempts.length <= 96 && progress.entries.length <= 16);
  assert.equal(new Set(progress.pages.map(p => p.pageKey)).size, progress.pages.length);
  for (const page of progress.pages) {
    const genre = GENRES.find(g => g.genreId === page.genreId);
    assert.ok(genre && ["top", "hype"].includes(page.feed) && page.pageKey === genre.genreId + ":" + page.feed
      && page.page === 1 && page.perPage === 36 && ["started", "ready", "unavailable"].includes(page.status));
    assert.ok(Array.isArray(page.rows) && page.rows.length <= 36);
    for (const row of page.rows) savedRow(row, genre);
    assert.equal(new Set(page.rows.map(row => row.id)).size, page.rows.length);
  }
  assert.equal(new Set(progress.attempts.map(a => a.beatportTrackId)).size, progress.attempts.length, "Global Beatport attempts cannot be retried.");
  for (const attempt of progress.attempts) {
    assert.ok(isId(attempt.beatportTrackId) && !request.excludedBeatportTrackIds.includes(attempt.beatportTrackId));
    assert.ok(COVERAGE_PROBE_REQUESTS.some(r => r.requestId === attempt.requestId && r.genreId === attempt.genreId));
    assert.ok(["anchor", "candidate"].includes(attempt.role) && ["started", "frozen-exact", "unavailable", "excluded"].includes(attempt.status));
    assert.ok((attempt.tidalQueries || []).length <= 3 && (attempt.canonicalLookups || []).length <= 3);
    assert.ok(progress.pages.some(p => p.genreId === attempt.genreId && p.rows.some(row => row.id === attempt.beatportTrackId)));
    if (attempt.status === "frozen-exact") assert.ok(progress.entries.some(e => e.track.identityKey === attempt.identityKey));
  }
  for (const spec of COVERAGE_PROBE_REQUESTS) {
    assert.ok(progress.attempts.filter(a => a.requestId === spec.requestId && a.role === "anchor").length <= 18);
    assert.ok(progress.attempts.filter(a => a.requestId === spec.requestId && a.role === "candidate").length <= 36);
  }
  assert.equal(progress.genres.length, 2); const seen = [];
  for (const entry of progress.entries) {
    assertSonicSourceSnapshot(entry.source, { track: entry.track });
    assert.equal(entry.verification?.provider, "tidal"); assert.equal(entry.verification.verified, true);
    assert.equal(entry.verification.identityKey, entry.track.identityKey); assert.deepEqual(entry.verification.canonicalTrack, entry.track);
    assert.ok(text(entry.sourceFile) && !excludedTrack(entry.track, request) && !request.excludedSourceSha256.includes(entry.source.sourceSha256) && !duplicate(entry, seen)); seen.push(entry);
  }
  assert.equal(progress.catalogProvenance.length, progress.entries.length);
  assert.equal(new Set(progress.catalogProvenance.map(p => p.identityKey)).size, progress.catalogProvenance.length);
  for (const proof of progress.catalogProvenance) {
    const entry = progress.entries.find(e => e.track.identityKey === proof.identityKey);
    assert.ok(entry && entry.source.snapshotKey === proof.sourceSnapshotKey && entry.source.sourceTrackId === proof.beatportTrackId);
    assert.ok(progress.pages.some(p => p.pageKey === proof.pageKey && p.genreId === proof.genreId
      && p.rows.some(row => row.id === proof.beatportTrackId && row.genre === proof.genreName
        && JSON.stringify(row.artistIds) === JSON.stringify(proof.artistIds))));
  }
  for (const [index, state] of progress.genres.entries()) {
    assert.equal(state.genreId, GENRES[index].genreId); assert.equal(state.genreName, GENRES[index].genreName);
    assert.ok(Array.isArray(state.anchorIdentityKeys) && state.anchorIdentityKeys.length <= 2
      && Array.isArray(state.candidateIdentityKeys) && state.candidateIdentityKeys.length <= 6);
    const keys = [...state.anchorIdentityKeys, ...state.candidateIdentityKeys]; assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.every(key => progress.catalogProvenance.some(p => p.identityKey === key && p.genreId === state.genreId)));
    assert.equal(new Set(state.anchorIdentityKeys.map(key => artist(progress.entries.find(e => e.track.identityKey === key).track))).size, state.anchorIdentityKeys.length);
    assert.ok(progress.attempts.filter(a => a.genreId === state.genreId).length <= 48);
  }
  const mark = () => persistProgress(clone(progress));
  async function page(genre, feed) {
    const pageKey = genre.genreId + ":" + feed, previous = progress.pages.find(p => p.pageKey === pageKey);
    if (previous) return previous;
    const stored = { pageKey, genreId: genre.genreId, genreName: genre.genreName, feed, page: 1, perPage: 36,
      status: "started", at: now(), rows: [], rejected: {} }; progress.pages.push(stored); await mark();
    try {
      const response = await beatport.getTrackFeed(feed, { genreId: genre.genreId, page: 1, perPage: 36 });
      assert.ok(Array.isArray(response?.tracks)); const rows = new Map();
      for (const input of response.tracks.slice(0, 36)) {
        try { const row = catalogueRow(input, genre); if (!rows.has(row.id)) rows.set(row.id, row); }
        catch { bump(stored.rejected, "malformed-or-wrong-catalogue-genre"); }
      }
      stored.rows = [...rows.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1); stored.status = "ready";
    } catch { stored.status = "unavailable"; stored.reason = "Fixed catalogue page unavailable."; }
    await mark(); return stored;
  }
  async function resolve(row, attempt) {
    const requested = requestedTrack(row), queries = [...new Set([
      [row.artist, row.title, row.mixName].filter(Boolean).join(" "), [row.artist, row.title].join(" "), row.isrc || ""
    ])].filter(Boolean).slice(0, 3), examined = new Set();
    attempt.tidalQueries = []; attempt.canonicalLookups = [];
    for (const query of queries) {
      if (attempt.canonicalLookups.length === 3) break;
      const search = { query, pageCount: 1, limit: 12, status: "started", candidateCount: 0, coarseRejections: {} };
      attempt.tidalQueries.push(search); await mark(); let rows;
      try { rows = await tidal.searchTracks(query, { limit: 12, detailLimit: 0, fullPage: false, pageCount: 1, rotateCatalog: false }); }
      catch { search.status = "unavailable"; await mark(); continue; }
      search.status = "complete"; const eligible = [];
      for (const result of (Array.isArray(rows) ? rows : []).slice(0, 12)) {
        search.candidateCount++;
        try {
          const candidate = canonicalTrack(result); if (examined.has(candidate.tidalId)) continue; examined.add(candidate.tidalId);
          const reason = coarseCandidateReason(requested, candidate); if (reason) { bump(search.coarseRejections, reason); continue; }
          eligible.push(candidate);
        } catch { bump(search.coarseRejections, "malformed-tidal-identity"); }
      }
      await mark(); eligible.sort((a, b) => BigInt(a.tidalId) < BigInt(b.tidalId) ? -1 : 1);
      for (const candidate of eligible) {
        if (attempt.canonicalLookups.length === 3) break;
        const lookup = { tidalId: candidate.tidalId, status: "started" }; attempt.canonicalLookups.push(lookup); await mark();
        try {
          const exact = canonicalTrack(await tidal.getTrack(candidate.tidalId, query)); assert.equal(exact.tidalId, candidate.tidalId);
          const reason = coarseCandidateReason(requested, exact); if (reason) { lookup.reason = reason; throw Error(reason); }
          const tidalMatch = scoreTidalIdentity(requested, exact), sourceMatch = matchBeatportVersionToTidal(exact, row, { allowVersionProxy: false, requestedBeatportTrackId: row.id });
          if (!tidalMatch.matched || !sourceMatch.matched || sourceMatch.relation !== "exact") {
            lookup.reason = "strict-canonical-identity-or-version-rejected"; throw Error(lookup.reason);
          }
          lookup.status = "verified"; await mark(); return exact;
        } catch { lookup.status = "unverified"; lookup.reason ||= "canonical-detail-unavailable"; await mark(); }
      }
    }
    throw Error("no-exact-canonical-recording");
  }
  async function source(spec, state, row, pageKey, role) {
    const prior = progress.attempts.find(a => a.beatportTrackId === row.id);
    if (prior) return prior.status === "frozen-exact" ? progress.entries.find(e => e.track.identityKey === prior.identityKey) : null;
    if (request.excludedBeatportTrackIds.includes(row.id) || progress.entries.length === 16 || progress.attempts.length === 96
      || progress.attempts.filter(a => a.genreId === spec.genreId).length === 48
      || progress.attempts.filter(a => a.requestId === spec.requestId && a.role === role).length === (role === "anchor" ? 18 : 36)) return null;
    const attempt = { beatportTrackId: row.id, genreId: spec.genreId, requestId: spec.requestId, role, pageKey,
      status: "started", at: now() }; progress.attempts.push(attempt); await mark();
    try {
      const track = await resolve(row, attempt);
      if (excludedTrack(track, request) || role === "anchor" && state.anchorIdentityKeys.some(key => artist(progress.entries.find(e => e.track.identityKey === key).track) === artist(track))) {
        attempt.status = "excluded"; attempt.reason = "exposed-heldout-or-duplicate-anchor-artist"; await mark(); return null;
      }
      if (progress.entries.some(e => e.track.identityKey === track.identityKey || recordingGroup(e.track) === recordingGroup(track)
        || work(e.track) === work(track) || isrc(track.isrc) && isrc(track.isrc) === isrc(e.track.isrc))) throw Error("duplicate-recording");
      const fetched = await beatport.fetchPreviewBuffer(row, { maxBytes: 20 * 1024 * 1024 });
      const bytes = fetched?.buffer instanceof Uint8Array ? fetched.buffer : fetched;
      assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 20 * 1024 * 1024);
      const sourceSha256 = hash(bytes);
      if (request.excludedSourceSha256.includes(sourceSha256) || progress.entries.some(e => e.source.sourceSha256 === sourceSha256)) throw Error("excluded-or-duplicate-source");
      const sourceFile = await saveAudio(bytes, { sourceSha256, identityKey: track.identityKey, beatportTrackId: row.id });
      assert.ok(text(sourceFile)); const durationSeconds = await probeDuration(sourceFile);
      assert.ok(Number.isFinite(durationSeconds) && durationSeconds >= 30 && durationSeconds <= 7200);
      assert.equal(hash(bytes), sourceSha256, "Original source bytes changed during storage/probing.");
      const frozen = freezeSonicSourceSnapshot({ track, sourceType: "beatport-preview", audioBytes: bytes, durationSeconds,
        sourceTrack: row, allowVersionProxy: false });
      const metadata = { query: "Beatport genre " + spec.genreId + " " + pageKey.split(":")[1] + " page 1",
        discoverySource: "exact Beatport genre catalogue resolved to canonical TIDAL", discoveryLane: "core", beatportGenre: row.genre };
      for (const [key, value] of [["beatportSubgenre", row.subGenre], ["label", row.label]]) if (text(value)) metadata[key] = text(value);
      if (Number.isFinite(row.bpm) && row.bpm > 0) metadata.bpm = row.bpm;
      const entry = { track, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: clone(track) },
        source: frozen, sourceFile, metadata };
      progress.entries.push(entry); progress.catalogProvenance.push({ identityKey: track.identityKey, beatportTrackId: row.id,
        sourceSnapshotKey: frozen.snapshotKey, genreId: row.genreId, genreName: row.genre, artistIds: clone(row.artistIds), pageKey });
      attempt.status = "frozen-exact"; attempt.identityKey = track.identityKey; await mark(); return entry;
    } catch (error) {
      attempt.status = "unavailable";
      attempt.reason = ["no-exact-canonical-recording", "duplicate-recording", "excluded-or-duplicate-source"].includes(error?.message)
        ? error.message : "exact-preview-source-unavailable";
      await mark(); return null;
    }
  }
  // Fetch the four predeclared pages once, including empty/error receipts.
  for (const genre of GENRES) for (const feed of ["top", "hype"]) await page(genre, feed);
  for (const [index, state] of progress.genres.entries()) {
    const specs = COVERAGE_PROBE_REQUESTS.filter(r => r.genreId === state.genreId);
    const pages = ["top", "hype"].map(feed => progress.pages.find(p => p.pageKey === state.genreId + ":" + feed));
    const ordered = Array.from({ length: 36 }, (_, i) => pages.flatMap(p => p.status === "ready" && p.rows[i]
      ? [{ row: p.rows[i], pageKey: p.pageKey }] : [])).flat();
    const records = new Map(), conflicting = new Set();
    for (const { row } of ordered) {
      const old = records.get(row.id); if (old && old.catalogRecordKey !== row.catalogRecordKey) conflicting.add(row.id); else records.set(row.id, row);
    }
    const eligible = ordered.filter(({ row }) => !conflicting.has(row.id) && !request.excludedBeatportTrackIds.includes(row.id));
    for (const spec of specs) {
      if (state.anchorIdentityKeys.length >= spec.anchorOrdinal) continue;
      for (const { row, pageKey } of eligible) {
        const entry = await source(spec, state, row, pageKey, "anchor");
        if (entry && !state.anchorIdentityKeys.includes(entry.track.identityKey)
          && !state.anchorIdentityKeys.some(key => artist(progress.entries.find(e => e.track.identityKey === key).track) === artist(entry.track))) {
          state.anchorIdentityKeys.push(entry.track.identityKey); await mark(); break;
        }
      }
    }
    if (state.anchorIdentityKeys.length < 2) continue;
    for (const { row, pageKey } of eligible) {
      if (state.candidateIdentityKeys.length === 6) break;
      const entry = await source(specs[0], state, row, pageKey, "candidate");
      if (entry && !state.anchorIdentityKeys.includes(entry.track.identityKey) && !state.candidateIdentityKeys.includes(entry.track.identityKey)) {
        state.candidateIdentityKeys.push(entry.track.identityKey); await mark();
      }
    }
  }
  const complete = progress.genres.every(g => g.anchorIdentityKeys.length === 2 && g.candidateIdentityKeys.length === 6);
  const requests = COVERAGE_PROBE_REQUESTS.flatMap(spec => {
    const state = progress.genres.find(g => g.genreId === spec.genreId), key = state.anchorIdentityKeys[spec.anchorOrdinal - 1];
    if (!key) return [];
    const anchor = progress.entries.find(e => e.track.identityKey === key);
    return [{ requestId: spec.requestId, anchorIdentityKey: key, candidateIdentityKeys: clone(state.candidateIdentityKeys),
      options: { scoringMode: "similar", request: "Find tracks like " + anchor.track.artist + " — " + anchor.track.title,
        anchorTrack: clone(anchor.track), count: 3, allowPreviousSuggestions: false, allowPreviousFallback: false } }];
  });
  return { progress, complete, pool: requests.length === 4 ? { version: 1, kind: "catalog-scout-pilot-pool",
    entries: clone(progress.entries), requests, catalogProvenance: clone(progress.catalogProvenance) } : null };
}

module.exports = { COVERAGE_PROBE_RECIPE, COVERAGE_PROBE_REQUESTS, validateCoverageProbeRequest,
  coarseCandidateReason, collectSonicCatalogScoutCoverageProbe };
