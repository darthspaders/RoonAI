"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const { collectSonicCatalogScoutPool } = require("../src/sonicCatalogScoutCollector");
const clone = value => structuredClone(value), hash = value => createHash("sha256").update(value).digest("hex");
function setup(overrides = {}) {
  const request = { version: 1, recipe: { maxSources: 100, maxCandidatesPerRequest: 6, maxCandidateAttempts: 18, maxAnchorAttempts: 4,
    maxQueriesPerRequest: 3, maxResultsPerQuery: 18, maxTidalQueriesPerSource: 3, maxTidalResultsPerQuery: 12, ...overrides },
    requests: Array.from({ length: 4 }, (_, family) => ({ requestId: `family-${family}`, anchorQuery: `Artist ${family}-0`, queries: Array.from({ length: 3 }, (_, lane) => `Artist ${family}-${lane}`), lane: `Sampling lane ${family}` })), excluded: [], excludedSourceSha256: [] };
  const pages = new Map(), providerRows = new Map();
  for (const [family, spec] of request.requests.entries()) for (const [lane, query] of spec.queries.entries()) {
    const rows = Array.from({ length: 18 }, (_, i) => { const id = String(1000 + family * 1000 + lane * 100 + i), row = { id, artist: query, title: `Source ${id}`, mixName: "Original Mix", album: `Album ${id}`,
      isrc: `GBKQU${id}`, durationMs: 360000, label: `BP label ${family}`, genre: `Actual BP genre ${family}`, year: "2019-01-11", previewUrl: `https://private-fixture.invalid/${id}.mp3` }; providerRows.set(id, row); return row; }); pages.set(query, rows.reverse());
  }
  const calls = { beatportPages: [], tidalSearch: [], details: [], preview: [], saved: [] }, persisted = [], audio = new Map();
  const exact = id => { const row = providerRows.get(String(id)); return { id: String(1000000 + Number(id)), artist: row.artist, title: row.title, mixVersion: row.mixName,
    album: row.album, isrc: row.isrc, durationMs: row.durationMs, label: "Canonical TIDAL label", year: "2020-01-01" }; };
  const deps = { request, requestSha256: hash(JSON.stringify(request)), now: () => "2026-10-08T00:00:00.000Z",
    beatport: { searchTracks: async options => { calls.beatportPages.push(clone(options)); return { tracks: clone(pages.get(options.query) || []) }; },
      fetchPreviewBuffer: async (row, options) => { calls.preview.push({ id: row.id, options }); return { buffer: Buffer.from(`exact-original-source-${row.id}`) }; } },
    tidal: { searchTracks: async (query, options) => { calls.tidalSearch.push({ query, options: clone(options) }); const id = query.match(/Source (\d+)/)?.[1]; return id ? [exact(id)] : []; },
      getTrack: async id => { calls.details.push(id); return exact(String(Number(id) - 1000000)); } },
    saveAudio: async (bytes, info) => { const file = `private-audio/${info.sourceSha256}.audio`; assert.equal(hash(bytes), info.sourceSha256); audio.set(file, Buffer.from(bytes)); calls.saved.push(clone(info)); return file; },
    probeDuration: async file => { assert.ok(audio.has(file)); return 120.032653; }, persistProgress: async progress => { persisted.push(clone(progress)); } };
  return { request, deps, calls, persisted, pages, providerRows, exact, audio };
}
test("four frozen artist-family requests yield bounded exact TIDAL previews in numeric round-robin order", async () => {
  const f = setup(), before = clone(f.request), result = await collectSonicCatalogScoutPool(f.deps);
  assert.equal(result.complete, true); assert.equal(result.pool.requests.length, 4); assert.equal(result.pool.entries.length, 28); assert.deepEqual(f.request, before);
  assert.equal(f.calls.beatportPages.length, 12); assert.ok(f.calls.beatportPages.every(row => row.page === 1 && row.perPage === 18));
  assert.ok(f.calls.tidalSearch.every(row => row.options.pageCount === 1 && row.options.rotateCatalog === false && row.options.limit === 12));
  const first = result.pool.requests[0]; assert.equal(first.anchorIdentityKey, "tidal:1001000");
  for (const row of result.pool.requests) { assert.equal(row.options.genres, undefined); assert.equal(row.options.genre, undefined); assert.match(row.options.request, /^Find tracks like /); }
  assert.deepEqual(f.request.requests.map(row => row.lane), before.requests.map(row => row.lane));
  assert.deepEqual(first.candidateIdentityKeys.slice(0, 4), ["tidal:1001100", "tidal:1001200", "tidal:1001001", "tidal:1001101"]);
  for (const entry of result.pool.entries) { assert.equal(entry.verification.identityKey, entry.track.identityKey); assert.equal(entry.verification.verified, true); assert.equal(entry.source.identityRelation, "exact");
    assert.equal(entry.source.sourceSha256, hash(f.audio.get(entry.sourceFile))); assert.equal(entry.source.sourceType, "beatport-preview"); assert.ok(Math.abs(entry.source.spans[0][1] - entry.source.spans[0][0] - 30) < 1e-8);
    assert.equal(entry.track.year, 2020); assert.equal(entry.track.genre, undefined); assert.match(entry.metadata.beatportGenre, /^Actual BP genre/); assert.equal(entry.track.label, "Canonical TIDAL label"); }
  assert.ok(result.progress.attempts.every(row => row.tidalQueries.length <= 3 && row.canonicalLookups.length <= 36));
});
test("completed resume is provider-free and preserves every source, attempt and budget receipt", async () => {
  const f = setup(), first = await collectSonicCatalogScoutPool(f.deps), before = clone(first.progress), counts = clone(f.calls);
  const resumed = await collectSonicCatalogScoutPool({ ...f.deps, progress: first.progress }); assert.deepEqual(resumed.pool, first.pool); assert.deepEqual(first.progress, before);
  assert.deepEqual(f.calls, counts); assert.equal(resumed.complete, true);
});
test("optional discovery hints retain only genuine strings and positive numeric BPM", async () => {
  const f = setup();
  for (const row of f.providerRows.values()) { row.bpm = "128"; row.genre = { name: "Unnormalized provider hint" }; row.subGenre = ["Unnormalized provider hint"]; }
  f.providerRows.get("1000").bpm = 128;
  const result = await collectSonicCatalogScoutPool(f.deps); assert.equal(result.complete, true);
  for (const entry of result.pool.entries) { assert.equal(entry.metadata.beatportGenre, undefined); assert.equal(entry.metadata.beatportSubgenre, undefined);
    assert.equal(entry.metadata.bpm, entry.source.sourceTrackId === "1000" ? 128 : undefined); assert.equal(typeof entry.metadata.label, "string"); }
});
test("a persisted interrupted attempt is not retried and resumed selection can finish within the original budget", async () => {
  const f = setup(); let interrupted = false;
  f.deps.persistProgress = async progress => { f.persisted.push(clone(progress)); if (!interrupted && progress.attempts.some(row => row.role === "candidate" && row.status === "started")) { interrupted = true; throw new Error("Simulated process interruption after durable start"); } };
  await assert.rejects(() => collectSonicCatalogScoutPool(f.deps), /durable start/); const progress = f.persisted.at(-1), lost = progress.attempts.find(row => row.status === "started");
  f.deps.persistProgress = async value => f.persisted.push(clone(value)); const result = await collectSonicCatalogScoutPool({ ...f.deps, progress });
  assert.equal(result.complete, true); assert.equal(result.progress.attempts.filter(row => row.requestId === lost.requestId && row.beatportTrackId === lost.beatportTrackId).length, 1);
  assert.equal(f.calls.preview.some(row => row.id === lost.beatportTrackId), false); assert.equal(result.progress.attempts.find(row => row.beatportTrackId === lost.beatportTrackId).status, "started");
});
test("wrong named version, changed canonical detail and missing previews are rejected before becoming frozen sources", async () => {
  const f = setup(), originalSearch = f.deps.tidal.searchTracks, originalDetail = f.deps.tidal.getTrack, originalPreview = f.deps.beatport.fetchPreviewBuffer;
  f.deps.tidal.searchTracks = async (query, options) => { const rows = await originalSearch(query, options); if (/Source 1100\b/.test(query)) rows.forEach(row => { row.mixVersion = "Other Named Remix"; }); return rows; };
  f.deps.tidal.getTrack = async id => { const row = await originalDetail(id); if (id === "1001200") row.title = "Different canonical recording"; return row; };
  f.deps.beatport.fetchPreviewBuffer = async (row, options) => { if (row.id === "1001") throw new Error("private URL or token must never enter reason text"); return originalPreview(row, options); };
  const result = await collectSonicCatalogScoutPool(f.deps); assert.equal(result.complete, true);
  for (const id of ["1001100", "1001200", "1001001"]) assert.ok(!result.pool.entries.some(entry => entry.track.tidalId === id));
  assert.equal(f.calls.preview.some(row => ["1100", "1200"].includes(row.id)), false); assert.doesNotMatch(JSON.stringify(result.progress.attempts.map(row => row.reason)), /URL|token/);
});
test("anchor exclusions cover exact identity, ISRC, base recording and original source bytes", async () => {
  const f = setup(); f.request.excluded = [{ identityKey: "tidal:1001000" }, { isrc: "GBKQU1001" }, { artist: "Artist 0-0", title: "Source 1002" }];
  f.request.excludedSourceSha256 = [hash(Buffer.from("exact-original-source-1003"))]; f.deps.requestSha256 = hash(JSON.stringify(f.request));
  const result = await collectSonicCatalogScoutPool(f.deps); assert.equal(result.complete, false); assert.equal(result.pool, null);
  assert.equal(result.progress.requests.some(row => row.requestId === "family-0"), false); assert.equal(result.progress.attempts.filter(row => row.requestId === "family-0" && row.role === "anchor").length, 4);
  assert.ok(!result.progress.entries.some(row => ["tidal:1001000", "tidal:1001001", "tidal:1001002", "tidal:1001003"].includes(row.track.identityKey)));
});
test("failed exact resolution consumes at most eighteen distinct candidate attempts and three one-page queries per source", async () => {
  const f = setup(), search = f.deps.tidal.searchTracks;
  f.deps.tidal.searchTracks = async (query, options) => { const id = query.match(/Source (\d+)/)?.[1]; if (id && Number(id) % 1000 === 0) return search(query, options); f.calls.tidalSearch.push({ query, options }); return []; };
  const result = await collectSonicCatalogScoutPool(f.deps); assert.equal(result.complete, false); assert.equal(result.pool, null); assert.equal(result.progress.entries.length, 4);
  for (const spec of f.request.requests) { const attempts = result.progress.attempts.filter(row => row.requestId === spec.requestId && row.role === "candidate"); assert.equal(attempts.length, 18); assert.equal(new Set(attempts.map(row => row.beatportTrackId)).size, 18); assert.ok(attempts.every(row => row.tidalQueries.length <= 3)); }
  const calls = clone(f.calls); await collectSonicCatalogScoutPool({ ...f.deps, progress: result.progress }); assert.deepEqual(f.calls, calls);
});
test("duplicate exact source and ISRC cannot impersonate extra candidate slots or replace the anchor", async () => {
  const f = setup(), preview = f.deps.beatport.fetchPreviewBuffer, search = f.deps.tidal.searchTracks;
  f.deps.beatport.fetchPreviewBuffer = async (row, options) => row.id === "1100" ? { buffer: Buffer.from("exact-original-source-1000") } : preview(row, options);
  f.deps.tidal.searchTracks = async (query, options) => { const found = await search(query, options); if (/Source 1200\b/.test(query)) found.forEach(row => { row.isrc = "GBKQU1000"; }); return found; };
  const result = await collectSonicCatalogScoutPool(f.deps); assert.equal(result.complete, true); assert.ok(!result.pool.entries.some(entry => ["tidal:1001100", "tidal:1001200"].includes(entry.track.identityKey)));
  assert.equal(new Set(result.pool.entries.map(entry => entry.source.sourceSha256)).size, result.pool.entries.length);
  for (const spec of result.pool.requests) assert.equal(new Set(spec.candidateIdentityKeys).size, 6);
});
test("an explicit budget extension uses only frozen pages and later candidate attempts without retrying eighteen failures", async () => {
  const f = setup(), search = f.deps.tidal.searchTracks;
  f.deps.tidal.searchTracks = async (query, options) => { const id = query.match(/Source (\d+)/)?.[1]; if (id && Number(id) % 1000 === 0) return search(query, options); f.calls.tidalSearch.push({ query, options }); return []; };
  const first = await collectSonicCatalogScoutPool(f.deps); assert.equal(first.complete, false);
  const failed = first.progress.attempts.filter(row => row.role === "candidate"), before = clone(first.progress), pageCount = f.calls.beatportPages.length, searchCount = f.calls.tidalSearch.length;
  assert.equal(failed.length, 4 * 18); assert.ok(failed.every(row => row.status === "unavailable-or-unverified"));
  const request = clone(f.request); request.recipe.maxCandidateAttempts = 36; request.recipe.maxAnchorAttempts = 18;
  const progress = clone(first.progress), requestSha256 = hash(JSON.stringify(request)); progress.requestSha256 = requestSha256;
  const result = await collectSonicCatalogScoutPool({ ...f.deps, request, requestSha256, progress, tidal: { ...f.deps.tidal, searchTracks: search } });
  assert.equal(result.complete, true); assert.equal(f.calls.beatportPages.length, pageCount); assert.deepEqual(first.progress, before);
  for (const prior of failed) assert.deepEqual(result.progress.attempts.find(row => row.requestId === prior.requestId && row.beatportTrackId === prior.beatportTrackId), prior);
  const failedIds = new Set(failed.map(row => row.beatportTrackId)); assert.ok(f.calls.tidalSearch.slice(searchCount).every(row => !failedIds.has(row.query.match(/Source (\d+)/)?.[1])));
  for (const spec of request.requests) { const attempts = result.progress.attempts.filter(row => row.requestId === spec.requestId && row.role === "candidate"); assert.equal(attempts.length, 24); assert.ok(attempts.length <= 36); }
});
test("an explicit anchor budget extension skips the original four failures and preserves already completed requests", async () => {
  const f = setup(), search = f.deps.tidal.searchTracks;
  f.deps.tidal.searchTracks = async (query, options) => { if (/Source 100[0-3]\b/.test(query)) { f.calls.tidalSearch.push({ query, options }); return []; } return search(query, options); };
  const first = await collectSonicCatalogScoutPool(f.deps); assert.equal(first.complete, false);
  const priorRequests = clone(first.progress.requests), oldPages = f.calls.beatportPages.length, oldQueries = f.calls.tidalSearch.length;
  const request = clone(f.request); request.recipe.maxAnchorAttempts = 18; request.recipe.maxCandidateAttempts = 36;
  const progress = clone(first.progress), requestSha256 = hash(JSON.stringify(request)); progress.requestSha256 = requestSha256;
  const result = await collectSonicCatalogScoutPool({ ...f.deps, request, requestSha256, progress, tidal: { ...f.deps.tidal, searchTracks: search } });
  assert.equal(result.complete, true); assert.equal(result.pool.requests.find(row => row.requestId === "family-0").anchorIdentityKey, "tidal:1001004");
  assert.equal(f.calls.beatportPages.length, oldPages); assert.ok(f.calls.tidalSearch.slice(oldQueries).every(row => !/Source 100[0-3]\b/.test(row.query)));
  assert.equal(result.progress.attempts.filter(row => row.requestId === "family-0" && row.role === "anchor").length, 5);
  for (const prior of priorRequests) assert.deepEqual(result.progress.requests.find(row => row.requestId === prior.requestId), prior);
});
test("global source and byte gates remain bounded even when providers return more rows or oversized previews", async () => {
  const f = setup({ maxSources: 3 }), result = await collectSonicCatalogScoutPool(f.deps); assert.equal(result.complete, false); assert.equal(result.progress.entries.length, 3); assert.equal(f.calls.preview.length, 3);
  const large = setup(); large.deps.beatport.fetchPreviewBuffer = async () => ({ buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
  const failed = await collectSonicCatalogScoutPool(large.deps); assert.equal(failed.complete, false); assert.equal(failed.progress.entries.length, 0); assert.equal(large.calls.saved.length, 0);
});
test("changed request hash or fabricated resume rows fail before any provider call", async () => {
  const f = setup(), result = await collectSonicCatalogScoutPool(f.deps), calls = clone(f.calls);
  for (const alter of [p => { p.requestSha256 = "a".repeat(64); }, p => { p.requests[0].candidateIdentityKeys[0] = "tidal:invented"; }, p => { p.attempts.push(clone(p.attempts[0])); },
    p => { p.entries[0].source.spans[0][0]++; }, p => { p.pages[0].tracks = Array(19).fill(p.pages[0].tracks[0]); }]) {
    const progress = clone(result.progress); alter(progress); await assert.rejects(() => collectSonicCatalogScoutPool({ ...f.deps, progress })); assert.deepEqual(f.calls, calls);
  }
});
