"use strict";

// Bounded provider orchestration with injected persistence/audio/probe functions.
// No provider construction, authentication writes, database, model or playback.
const assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const { publicTrack } = require("./sonicEnsembleEvaluation");
const { freezeSonicSourceSnapshot, assertSonicSourceSnapshot } = require("./sonicCandidateCorpus");
const { scoreTidalIdentity } = require("./exactTrackVerification");
const { matchBeatportVersionToTidal } = require("./beatportVersionMatch");
const { recordingGroup } = require("./sonicAnalysisPilot");
const { normalizeCatalogText, parseCanonicalCatalogIdentity } = require("./catalogIdentityNormalization");
const clone = value => JSON.parse(JSON.stringify(value));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const numeric = (a, b) => { const left = BigInt(a), right = BigInt(b); return left < right ? -1 : left > right ? 1 : 0; };
const text = value => typeof value === "string" ? value.trim().slice(0, 1024) : "";
function idFor(row) {
  const id = String(row?.tidalId || row?.id || "");
  assert.match(id, /^[1-9]\d*$/);
  for (const other of [row.tidalId, row.id, row.identityKey?.startsWith("tidal:") ? row.identityKey.slice(6) : undefined].filter(value => value !== undefined && value !== "")) assert.equal(String(other), id, "Canonical TIDAL identity conflict.");
  return id;
}
function canonicalTrack(row) {
  const id = idFor(row), track = { ...publicTrack(row), identityKey: `tidal:${id}`, tidalId: id };
  if (row.version && !track.mixVersion) track.mixVersion = text(row.version);
  for (const key of ["genre", "subgenre"]) if (Array.isArray(track[key])) track[key] = track[key].filter(value => typeof value === "string").join("; ");
  if (!Number.isInteger(track.year)) { const year = Number(String(track.year || "").slice(0, 4)); if (year >= 1000 && year <= 9999) track.year = year; else delete track.year; }
  for (const key of Object.keys(track)) if (track[key] === null || track[key] === "") delete track[key];
  assert.ok(text(track.artist) && text(track.title), "Canonical artist and title are required."); return track;
}
function beatportRow(raw) {
  const id = String(raw?.id || raw?.beatportTrackId || ""); assert.match(id, /^[1-9]\d*$/);
  assert.ok(text(raw.artist) && text(raw.title), "Beatport artist/title unavailable.");
  const row = { id, artist: text(raw.artist), title: text(raw.title) };
  for (const key of ["mixName", "mixVersion", "album", "isrc", "label", "genre", "subGenre", "bpm", "keyName", "camelot", "releaseDate", "year", "durationMs", "previewUrl"]) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") row[key] = clone(raw[key]);
  }
  return row;
}
function requestedTrack(row) {
  return { artist: row.artist, title: row.title, mixVersion: row.mixName || row.mixVersion || "", beatportTrackId: row.id,
    ...Object.fromEntries(["album", "isrc", "label", "durationMs"].filter(key => row[key] !== undefined).map(key => [key, row[key]])) };
}
function baseWork(track) { return [normalizeCatalogText(track.artist), parseCanonicalCatalogIdentity(track).normalizedBaseTitle].join("|"); }
function sourceDuplicate(entry, others) {
  return others.some(other => other.track.identityKey === entry.track.identityKey || other.source.sourceSha256 === entry.source.sourceSha256
    || recordingGroup(other.track) === recordingGroup(entry.track) || baseWork(other.track) === baseWork(entry.track)
    || entry.track.isrc && other.track.isrc === entry.track.isrc);
}
function anchorExcluded(entry, request) {
  return (request.excludedSourceSha256 || []).includes(entry.source.sourceSha256) || (request.excluded || []).some(old => old.identityKey === entry.track.identityKey
    || old.isrc && old.isrc === entry.track.isrc || old.recordingGroup && old.recordingGroup === recordingGroup(entry.track)
    || old.artist && old.title && (recordingGroup(old) === recordingGroup(entry.track) || baseWork(old) === baseWork(entry.track)));
}
function validateRequest(request) {
  assert.equal(request?.version, 1); assert.ok(Array.isArray(request.requests) && request.requests.length >= 4 && request.requests.length <= 6);
  assert.equal(new Set(request.requests.map(row => row.requestId)).size, request.requests.length);
  const limits = request.recipe;
  for (const [key, maximum] of [["maxSources", 100], ["maxCandidatesPerRequest", 12], ["maxCandidateAttempts", 36], ["maxAnchorAttempts", 18], ["maxQueriesPerRequest", 3], ["maxResultsPerQuery", 18], ["maxTidalQueriesPerSource", 3], ["maxTidalResultsPerQuery", 12]]) {
    assert.ok(Number.isInteger(limits?.[key]) && limits[key] >= 1 && limits[key] <= maximum, `Invalid bounded collector ${key}.`);
  }
  assert.ok(limits.maxCandidatesPerRequest >= 6 && limits.maxCandidateAttempts >= 6);
  for (const row of request.requests) assert.ok(text(row.requestId) && text(row.anchorQuery) && text(row.lane) && Array.isArray(row.queries)
    && row.queries.length <= limits.maxQueriesPerRequest && row.queries.length === 3 && new Set(row.queries).size === row.queries.length && row.queries.every(text));
  assert.ok(Array.isArray(request.excluded || []) && (request.excluded || []).length <= 10000);
  assert.ok(Array.isArray(request.excludedSourceSha256 || []) && (request.excludedSourceSha256 || []).every(value => /^[a-f0-9]{64}$/.test(value)));
  return limits;
}

async function collectSonicCatalogScoutPool({ request, requestSha256, progress: supplied = null, beatport, tidal, saveAudio, probeDuration, persistProgress, now = () => new Date().toISOString() } = {}) {
  const limits = validateRequest(request); assert.match(requestSha256, /^[a-f0-9]{64}$/);
  for (const method of [beatport?.searchTracks, beatport?.fetchPreviewBuffer, tidal?.searchTracks, tidal?.getTrack, saveAudio, probeDuration, persistProgress, now]) assert.equal(typeof method, "function", "Inject every bounded collector dependency.");
  const progress = supplied ? clone(supplied) : { version: 1, candidateProviderPolicy: "beatport-artist-pages-tidal-exact", requestSha256, pages: [], entries: [], requests: [], attempts: [] };
  assert.equal(progress.version, 1); assert.equal(progress.candidateProviderPolicy, "beatport-artist-pages-tidal-exact"); assert.equal(progress.requestSha256, requestSha256);
  for (const key of ["pages", "entries", "requests", "attempts"]) assert.ok(Array.isArray(progress[key]));
  assert.ok(progress.entries.length <= limits.maxSources && progress.pages.length <= request.requests.length * 3 && progress.attempts.length <= request.requests.length * (limits.maxAnchorAttempts + limits.maxCandidateAttempts));
  const allowedQueries = new Set(request.requests.flatMap(spec => spec.queries)), specs = new Map(request.requests.map(spec => [spec.requestId, spec]));
  assert.equal(new Set(progress.pages.map(row => row.query)).size, progress.pages.length, "Duplicate frozen provider pages.");
  for (const page of progress.pages) { assert.ok(allowedQueries.has(page.query) && page.provider === "beatport" && page.page === 1 && ["started", "ready", "unavailable"].includes(page.status));
    assert.ok(Array.isArray(page.tracks) && page.tracks.length <= limits.maxResultsPerQuery); assert.equal(new Set(page.tracks.map(row => beatportRow(row).id)).size, page.tracks.length); }
  const seen = [];
  for (const entry of progress.entries) {
    assertSonicSourceSnapshot(entry.source, { track: entry.track }); assert.equal(entry.verification?.provider, "tidal"); assert.equal(entry.verification.verified, true);
    assert.equal(entry.verification.identityKey, entry.track.identityKey); assert.deepEqual(entry.verification.canonicalTrack, entry.track);
    assert.ok(typeof entry.sourceFile === "string" && entry.sourceFile && !sourceDuplicate(entry, seen), "Conflicting frozen source entries."); seen.push(entry);
  }
  assert.equal(new Set(progress.attempts.map(row => `${row.requestId}|${row.beatportTrackId}`)).size, progress.attempts.length, "A Beatport recording attempt cannot be retried.");
  for (const attempt of progress.attempts) { assert.ok(specs.has(attempt.requestId) && ["anchor", "candidate"].includes(attempt.role)); assert.match(attempt.beatportTrackId, /^[1-9]\d*$/);
    assert.ok(["started", "frozen-exact", "unavailable-or-unverified", "excluded-or-duplicate"].includes(attempt.status));
    assert.ok((attempt.tidalQueries || []).length <= limits.maxTidalQueriesPerSource && (attempt.canonicalLookups || []).length <= limits.maxTidalQueriesPerSource * limits.maxTidalResultsPerQuery);
    if (attempt.status === "frozen-exact") assert.ok(progress.entries.some(entry => entry.track.identityKey === attempt.identityKey)); }
  for (const spec of request.requests) {
    assert.ok(progress.attempts.filter(row => row.requestId === spec.requestId && row.role === "anchor").length <= limits.maxAnchorAttempts);
    assert.ok(progress.attempts.filter(row => row.requestId === spec.requestId && row.role === "candidate").length <= limits.maxCandidateAttempts);
  }
  assert.equal(new Set(progress.requests.map(row => row.requestId)).size, progress.requests.length);
  for (const saved of progress.requests) {
    assert.ok(specs.has(saved.requestId)); const anchor = progress.entries.find(entry => entry.track.identityKey === saved.anchorIdentityKey);
    assert.ok(anchor && !anchorExcluded(anchor, request)); assert.ok(Array.isArray(saved.candidateIdentityKeys) && saved.candidateIdentityKeys.length <= limits.maxCandidatesPerRequest);
    const selected = [anchor]; for (const key of saved.candidateIdentityKeys) { const entry = progress.entries.find(entry => entry.track.identityKey === key); assert.ok(entry && !sourceDuplicate(entry, selected)); selected.push(entry); }
    assert.equal(saved.complete, saved.candidateIdentityKeys.length >= 6);
  }
  const mark = async () => persistProgress(clone(progress));
  async function page(query) {
    let saved = progress.pages.find(row => row.query === query);
    if (saved) return saved.status === "ready" ? saved.tracks : [];
    saved = { query, provider: "beatport", page: 1, status: "started", at: now(), tracks: [] }; progress.pages.push(saved); await mark();
    try {
      const response = await beatport.searchTracks({ query, page: 1, perPage: limits.maxResultsPerQuery });
      const rows = Array.isArray(response) ? response : response?.tracks; assert.ok(Array.isArray(rows));
      const byId = new Map();
      for (const raw of rows.slice(0, limits.maxResultsPerQuery)) { try { const row = beatportRow(raw); if (!byId.has(row.id)) byId.set(row.id, row); } catch { /* malformed provider row is not an exact source */ } }
      saved.tracks = [...byId.values()].sort((a, b) => numeric(a.id, b.id)); saved.status = "ready";
    } catch { saved.status = "unavailable"; saved.reason = "Bounded Beatport page unavailable."; }
    await mark(); return saved.tracks;
  }
  async function resolve(provider, attempt) {
    const requested = requestedTrack(provider), queries = [...new Set([`${provider.artist} ${provider.title} ${provider.mixName || provider.mixVersion || ""}`.trim(), `${provider.artist} ${provider.title}`.trim(), provider.isrc || ""])].filter(Boolean).slice(0, limits.maxTidalQueriesPerSource), examined = new Set();
    attempt.tidalQueries = []; attempt.canonicalLookups = [];
    for (const query of queries) {
      attempt.tidalQueries.push({ query, pageCount: 1, status: "started" }); await mark();
      let found;
      try { found = await tidal.searchTracks(query, { limit: limits.maxTidalResultsPerQuery, detailLimit: 0, fullPage: false, pageCount: 1, rotateCatalog: false }); }
      catch { attempt.tidalQueries.at(-1).status = "unavailable"; await mark(); continue; }
      attempt.tidalQueries.at(-1).status = "complete"; await mark();
      if (!Array.isArray(found)) continue;
      const safe = [];
      for (const supplied of found.slice(0, limits.maxTidalResultsPerQuery)) {
        try { const id = idFor(supplied); if (examined.has(id)) continue; examined.add(id); const candidate = canonicalTrack(supplied);
          const match = matchBeatportVersionToTidal(candidate, provider, { allowVersionProxy: false, requestedBeatportTrackId: provider.id });
          if (scoreTidalIdentity(requested, candidate).matched && match.matched && match.relation === "exact") safe.push({ id, supplied: candidate });
        } catch { /* TIDAL search is discovery evidence; exact detail must pass */ }
      }
      safe.sort((a, b) => numeric(a.id, b.id));
      for (const row of safe) {
        attempt.canonicalLookups.push({ tidalId: row.id, status: "started" }); await mark();
        try { const raw = await tidal.getTrack(row.id, query), exact = canonicalTrack(raw); assert.equal(exact.tidalId, row.id);
          assert.ok(scoreTidalIdentity(row.supplied, exact).matched && scoreTidalIdentity(requested, exact).matched);
          const match = matchBeatportVersionToTidal(exact, provider, { allowVersionProxy: false, requestedBeatportTrackId: provider.id }); assert.ok(match.matched && match.relation === "exact");
          attempt.canonicalLookups.at(-1).status = "verified"; await mark(); return exact;
        } catch { attempt.canonicalLookups.at(-1).status = "unverified"; await mark(); }
      }
    }
    throw new Error("No exact canonical TIDAL recording and version.");
  }
  async function attemptSource(spec, provider, query, role) {
    const prior = progress.attempts.find(row => row.requestId === spec.requestId && row.beatportTrackId === provider.id);
    if (prior) return prior.status === "frozen-exact" ? progress.entries.find(row => row.track.identityKey === prior.identityKey) : null;
    const attempt = { requestId: spec.requestId, beatportTrackId: provider.id, role, query, at: now(), status: "started" }; progress.attempts.push(attempt); await mark();
    try {
      const track = await resolve(provider, attempt), existing = progress.entries.find(entry => entry.track.identityKey === track.identityKey);
      if (role === "anchor") assert.ok(!anchorExcluded({ track, source: { sourceSha256: "" } }, request), "The anchor recording was already exposed.");
      let entry = existing;
      if (existing) { assert.equal(existing.source.sourceTrackId, provider.id, "A different Beatport source cannot replace the frozen preview."); assertSonicSourceSnapshot(existing.source, { track }); }
      if (!entry) {
        assert.ok(progress.entries.length < limits.maxSources, "Exact source cap reached.");
        const streamed = await beatport.fetchPreviewBuffer(provider, { maxBytes: 20 * 1024 * 1024 }), bytes = streamed?.buffer instanceof Uint8Array ? streamed.buffer : streamed;
        assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 20 * 1024 * 1024, "Exact preview byte bound exceeded.");
        const sourceSha256 = hash(bytes); if (role === "anchor") assert.ok(!(request.excludedSourceSha256 || []).includes(sourceSha256), "The anchor audio source was already exposed.");
        const sourceFile = await saveAudio(bytes, { sourceSha256, beatportTrackId: provider.id, identityKey: track.identityKey });
        assert.ok(typeof sourceFile === "string" && sourceFile, "Injected private audio saver must return its verified path.");
        const durationSeconds = await probeDuration(sourceFile); assert.ok(Number.isFinite(durationSeconds) && durationSeconds >= 30 && durationSeconds <= 7200);
        assert.equal(hash(bytes), sourceSha256, "Original preview bytes changed during storage/probing.");
        const source = freezeSonicSourceSnapshot({ track, sourceType: "beatport-preview", audioBytes: bytes, durationSeconds, sourceTrack: provider, allowVersionProxy: false });
        const metadata = { query, discoverySource: "exact Beatport artist page resolved to canonical TIDAL", discoveryLane: "core" };
        for (const [key, from] of [["beatportGenre", "genre"], ["beatportSubgenre", "subGenre"], ["label", "label"]]) if (text(provider[from])) metadata[key] = text(provider[from]);
        if (typeof provider.bpm === "number" && Number.isFinite(provider.bpm) && provider.bpm > 0) metadata.bpm = provider.bpm;
        entry = { track, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: clone(track) }, source, sourceFile, metadata };
        assert.ok(!sourceDuplicate(entry, progress.entries), "Duplicate recording, source or base work."); progress.entries.push(entry);
      }
      attempt.identityKey = entry.track.identityKey; attempt.status = "frozen-exact"; await mark(); return entry;
    } catch { attempt.status = "unavailable-or-unverified"; attempt.reason = "Exact catalog recording, preview or source unavailable."; await mark(); return null; }
  }
  for (const spec of request.requests) {
    const saved = progress.requests.find(row => row.requestId === spec.requestId); if (saved?.complete) continue;
    const pages = []; for (const query of spec.queries) pages.push(await page(query));
    const own = pages[spec.queries.indexOf(spec.anchorQuery) >= 0 ? spec.queries.indexOf(spec.anchorQuery) : 0];
    let anchor = saved?.anchorIdentityKey ? progress.entries.find(entry => entry.track.identityKey === saved.anchorIdentityKey) : null;
    for (const provider of own) {
      if (anchor) break;
      const existing = progress.attempts.find(row => row.requestId === spec.requestId && row.beatportTrackId === provider.id);
      if (!existing && progress.attempts.filter(row => row.requestId === spec.requestId && row.role === "anchor").length >= limits.maxAnchorAttempts) break;
      const entry = await attemptSource(spec, provider, spec.anchorQuery, "anchor");
      if (entry && !anchorExcluded(entry, request) && !sourceDuplicate(entry, progress.requests.filter(row => row.anchorIdentityKey).map(row => progress.entries.find(entry => entry.track.identityKey === row.anchorIdentityKey)).filter(Boolean))) anchor = entry;
      else if (entry) { existing || Object.assign(progress.attempts.at(-1), { status: "excluded-or-duplicate" }); await mark(); }
    }
    if (!anchor) { await mark(); continue; }
    const selected = saved?.candidateIdentityKeys?.map(key => progress.entries.find(entry => entry.track.identityKey === key)).filter(Boolean) || [];
    const ordered = Array.from({ length: limits.maxResultsPerQuery }, (_, index) => pages.map((rows, pageIndex) => rows[index] ? { provider: rows[index], query: spec.queries[pageIndex] } : null).filter(Boolean)).flat();
    for (const { provider, query } of ordered) {
      if (selected.length >= limits.maxCandidatesPerRequest) break;
      const prior = progress.attempts.find(row => row.requestId === spec.requestId && row.beatportTrackId === provider.id);
      if (prior?.role === "anchor") continue;
      if (!prior && progress.attempts.filter(row => row.requestId === spec.requestId && row.role === "candidate").length >= limits.maxCandidateAttempts) break;
      const entry = await attemptSource(spec, provider, query, "candidate");
      if (entry && !sourceDuplicate(entry, [anchor, ...selected])) selected.push(entry);
    }
    const result = { requestId: spec.requestId, anchorIdentityKey: anchor.track.identityKey, candidateIdentityKeys: selected.map(entry => entry.track.identityKey), complete: selected.length >= 6,
      options: { scoringMode: "similar", request: `Find tracks like ${anchor.track.artist} — ${anchor.track.title}`, anchorTrack: clone(anchor.track), count: 3, allowPreviousSuggestions: false, allowPreviousFallback: false } };
    if (saved) Object.assign(saved, result); else progress.requests.push(result); await mark();
  }
  const complete = request.requests.every(spec => progress.requests.some(row => row.requestId === spec.requestId && row.complete));
  return { progress, complete, pool: complete ? { version: 1, kind: "catalog-scout-pilot-pool", entries: clone(progress.entries), requests: progress.requests.map(({ complete, ...row }) => clone(row)) } : null };
}

module.exports = { collectSonicCatalogScoutPool, canonicalTrack, validateRequest };
