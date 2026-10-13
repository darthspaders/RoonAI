"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const { normalizeBeatportTrack } = require("../src/beatportClient");
const { scoreTidalIdentity } = require("../src/exactTrackVerification");
const { COVERAGE_PROBE_RECIPE, COVERAGE_PROBE_REQUESTS, collectSonicCatalogScoutCoverageProbe, coarseCandidateReason } = require("../src/sonicCatalogScoutCoverageProbe");
const clone = value => structuredClone(value), hash = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const request = { version: 1, recipe: { ...COVERAGE_PROBE_RECIPE }, requests: clone(COVERAGE_PROBE_REQUESTS),
    excludedBeatportTrackIds: [], excluded: [], excludedSourceSha256: [],
    heldOut: Array.from({ length: 6 }, (_, i) => ({ identityKey: "text:reserved-" + i, artist: "Reserved " + i, title: "Reserved title " + i })),
    tasteSnapshot: { version: 1, readonlyFixture: true }, historySnapshot: { entries: [], settings: {} } };
  const pages = new Map(), byId = new Map(), calls = { pages: [], searches: [], details: [], previews: [], saves: [] }, audio = new Map(), persisted = [];
  for (const genre of ["91", "92"]) for (const feed of ["top", "hype"]) {
    const name = genre === "91" ? "Bass House" : "Techno (Raw / Deep / Hypnotic)", start = genre === "91" ? 1000 : 2000;
    const rows = Array.from({ length: 36 }, (_, i) => {
      const id = String(start + (feed === "hype" ? 100 : 0) + i), raw = { id, name: "Source " + id, mix_name: "Original Mix",
        artists: [{ id: String(100000 + Number(id)), name: "Artist " + id }], genre: { id: Number(genre), name },
        release: { name: "Album " + id, label: { name: "Label " + id }, publish_date: "2020-01-01" },
        isrc: "GBKQU" + id, bpm: 128, length_ms: 360000, sample_url: "https://private-fixture.invalid/" + id + ".mp3" };
      byId.set(id, raw); return normalizeBeatportTrack(raw);
    }); pages.set(genre + ":" + feed, rows.reverse());
  }
  const exact = id => { const raw = byId.get(String(id)); return { id: String(1000000 + Number(id)), artist: raw.artists[0].name,
    title: raw.name, mixVersion: raw.mix_name, album: raw.release.name, label: raw.release.label.name, isrc: raw.isrc,
    durationMs: raw.length_ms, year: 2020, releaseDate: "2020-01-01" }; };
  const deps = { request, requestSha256: hash(JSON.stringify(request)), now: () => "2026-10-08T00:00:00.000Z",
    beatport: { getTrackFeed: async (feed, options) => { calls.pages.push({ feed, ...clone(options) });
      return { chart: { title: "Top 100 Progressive House Tracks" }, tracks: clone(pages.get(options.genreId + ":" + feed)) }; },
      fetchPreviewBuffer: async (row, options) => { calls.previews.push({ id: row.id, ...options }); return { buffer: Buffer.from("exact-source-" + row.id) }; } },
    tidal: { searchTracks: async (query, options) => { calls.searches.push({ query, options: clone(options) }); const id = query.match(/Source (\d+)/)?.[1];
      return id ? [{ id: exact(id).id, artist: exact(id).artist, title: exact(id).title }] : []; },
      getTrack: async id => { calls.details.push(id); return exact(String(Number(id) - 1000000)); } },
    saveAudio: async (bytes, info) => { assert.equal(hash(bytes), info.sourceSha256); const file = "private/" + info.sourceSha256 + ".audio";
      audio.set(file, Buffer.from(bytes)); calls.saves.push(clone(info)); return file; },
    probeDuration: async file => { assert.ok(audio.has(file)); return 120.032653; },
    persistProgress: async progress => { persisted.push(clone(progress)); } };
  return { request, deps, calls, pages, byId, exact, audio, persisted };
}
test("four actual genre requests share six exact candidates per genre within sixteen sources and four fixed pages", async () => {
  const f = fixture(), before = clone(f.request), result = await collectSonicCatalogScoutCoverageProbe(f.deps);
  assert.equal(result.complete, true); assert.equal(result.pool.entries.length, 16); assert.equal(result.pool.requests.length, 4); assert.deepEqual(f.request, before);
  assert.equal(f.calls.pages.length, 4); assert.ok(f.calls.pages.every(p => p.page === 1 && p.perPage === 36));
  assert.deepEqual(f.calls.pages.map(p => p.genreId + ":" + p.feed), ["91:top", "91:hype", "92:top", "92:hype"]);
  assert.equal(f.calls.details.length, 16); assert.equal(f.calls.previews.length, 16); assert.equal(f.calls.saves.length, 16);
  for (const [a, b] of [[0, 1], [2, 3]]) { const left = result.pool.requests[a], right = result.pool.requests[b];
    assert.notEqual(left.anchorIdentityKey, right.anchorIdentityKey); assert.deepEqual(left.candidateIdentityKeys, right.candidateIdentityKeys); assert.equal(left.candidateIdentityKeys.length, 6); }
  for (const row of result.pool.requests) { assert.equal(row.options.genres, undefined); assert.equal(row.options.genre, undefined); assert.equal(row.options.count, 3); }
  for (const entry of result.pool.entries) { const proof = result.pool.catalogProvenance.find(p => p.identityKey === entry.track.identityKey);
    assert.ok(["91", "92"].includes(proof.genreId)); assert.equal(proof.genreName, entry.metadata.beatportGenre); assert.equal(proof.artistIds.length, 1);
    assert.equal(entry.source.sourceSha256, hash(f.audio.get(entry.sourceFile))); assert.equal(entry.source.identityRelation, "exact");
    assert.equal(entry.source.allowVersionProxy, false); assert.ok(Math.abs(entry.source.spans[0][1] - entry.source.spans[0][0] - 30) < 1e-9); }
  assert.ok(f.calls.searches.every(s => s.options.limit === 12 && s.options.detailLimit === 0 && s.options.pageCount === 1 && s.options.rotateCatalog === false));
});
test("missing search version, ISRC and duration may reach canonical detail, while the unchanged final exact gate still applies", async () => {
  const f = fixture();
  const requested = { artist: "Artist 1000", title: "Source 1000", mixVersion: "Original Mix", album: "Album 1000",
    label: "Label 1000", isrc: "GBKQU1000", durationMs: 360000 };
  const search = { artist: "Artist 1000", title: "Source 1000" };
  assert.equal(scoreTidalIdentity(requested, search).matched, false); assert.equal(coarseCandidateReason(requested, search), null);
  assert.equal(scoreTidalIdentity(requested, f.exact("1000")).matched, true);
  const result = await collectSonicCatalogScoutCoverageProbe(f.deps); assert.equal(result.complete, true);
  assert.ok(result.progress.attempts.every(a => a.canonicalLookups.some(d => d.status === "verified")));
});
test("an unlabeled canonical version with only equivalent-recording provenance remains excluded by the exact source gate", async () => {
  const f = fixture(), get = f.deps.tidal.getTrack;
  f.deps.tidal.getTrack = async id => { const exact = await get(id); delete exact.mixVersion; return exact; };
  const result = await collectSonicCatalogScoutCoverageProbe(f.deps); assert.equal(result.complete, false); assert.equal(result.progress.entries.length, 0);
  assert.equal(f.calls.previews.length, 0);
  assert.ok(result.progress.attempts.every(a => a.canonicalLookups.some(d => d.reason === "strict-canonical-identity-or-version-rejected")));
});
test("explicit named remix, artist and ISRC conflicts never receive a canonical lookup", async () => {
  const f = fixture(), search = f.deps.tidal.searchTracks;
  f.deps.tidal.searchTracks = async (query, options) => { const rows = await search(query, options), id = query.match(/Source (\d+)/)?.[1];
    if (id === "1000") rows.forEach(r => { r.mixVersion = "Different Named Remix"; });
    if (id === "1100") rows.forEach(r => { r.artist = "Conflicting Artist"; });
    if (id === "1001") rows.forEach(r => { r.isrc = "DIFFERENTISRC"; }); return rows; };
  const result = await collectSonicCatalogScoutCoverageProbe(f.deps); assert.equal(result.complete, true);
  for (const id of ["1001000", "1001100", "1001001"]) assert.equal(f.calls.details.includes(id), false);
  const rejected = result.progress.attempts.flatMap(a => a.tidalQueries).flatMap(q => Object.keys(q.coarseRejections));
  assert.ok(rejected.includes("version-conflict") && rejected.includes("artist-credit-conflict") && rejected.includes("isrc-conflict"));
});
test("a changed canonical version or identity is rejected even after safe incomplete search evidence", async () => {
  const f = fixture(), get = f.deps.tidal.getTrack;
  f.deps.tidal.getTrack = async id => { const r = await get(id); if (id === "1001000") r.mixVersion = "Other Named Remix"; if (id === "1001100") r.id = "999999999"; return r; };
  const result = await collectSonicCatalogScoutCoverageProbe(f.deps); assert.equal(result.complete, true);
  assert.ok(!result.pool.entries.some(e => ["tidal:1001000", "tidal:1001100"].includes(e.track.identityKey)));
  assert.ok(!f.calls.previews.some(p => ["1000", "1100"].includes(p.id)));
});
test("hardcoded collection titles and free-text artist matches cannot substitute for actual row genre identity", async () => {
  const f = fixture(); for (const [key, rows] of f.pages) if (key.startsWith("91:")) for (const row of rows) {
    row.rawJson.genre = { id: 92, name: "Techno (Raw / Deep / Hypnotic)" }; row.genre = "Bass House";
  }
  const result = await collectSonicCatalogScoutCoverageProbe(f.deps); assert.equal(result.complete, false); assert.equal(result.pool, null);
  assert.equal(result.progress.attempts.some(a => a.genreId === "91"), false);
  assert.ok(result.progress.pages.filter(p => p.genreId === "91").every(p => p.rejected["malformed-or-wrong-catalogue-genre"] === 36));
});
test("global prior Beatport attempts, prior review recordings, heldouts and source hashes are excluded without proxy substitutions", async () => {
  const f = fixture(); f.request.excludedBeatportTrackIds = ["1000"];
  f.request.excluded = [{ identityKey: "tidal:1001100", artist: "Artist 1100", title: "Source 1100" }];
  f.request.heldOut[0] = { identityKey: "tidal:1001001", artist: "Artist 1001", title: "Source 1001", isrc: "GBKQU1001" };
  f.request.excludedSourceSha256 = [hash(Buffer.from("exact-source-1101"))]; f.deps.requestSha256 = hash(JSON.stringify(f.request));
  const result = await collectSonicCatalogScoutCoverageProbe(f.deps); assert.equal(result.complete, true);
  assert.equal(result.progress.attempts.some(a => a.beatportTrackId === "1000"), false);
  assert.equal(f.calls.searches.some(s => /Source 1000\b/.test(s.query)), false);
  for (const id of ["1001000", "1001100", "1001001", "1001101"]) assert.ok(!result.pool.entries.some(e => e.track.identityKey === "tidal:" + id));
  assert.ok(!f.calls.previews.some(p => ["1100", "1001"].includes(p.id))); assert.ok(!f.calls.saves.some(p => p.beatportTrackId === "1101"));
});
test("completed resume makes no provider or audio calls and preserves all frozen evidence", async () => {
  const f = fixture(), first = await collectSonicCatalogScoutCoverageProbe(f.deps), before = clone(first.progress), calls = clone(f.calls);
  const second = await collectSonicCatalogScoutCoverageProbe({ ...f.deps, progress: first.progress });
  assert.equal(second.complete, true); assert.deepEqual(second.pool, first.pool); assert.deepEqual(first.progress, before); assert.deepEqual(f.calls, calls);
});
test("unavailable fixed pages are preserved and never retried or replaced by free-text discovery", async () => {
  const f = fixture(); f.deps.beatport.getTrackFeed = async (feed, options) => { f.calls.pages.push({ feed, ...options }); throw Error("Private upstream body or credential"); };
  const first = await collectSonicCatalogScoutCoverageProbe(f.deps); assert.equal(first.complete, false); assert.equal(first.pool, null);
  assert.equal(f.calls.pages.length, 4); assert.equal(first.progress.attempts.length, 0);
  assert.ok(first.progress.pages.every(p => p.status === "unavailable")); assert.doesNotMatch(JSON.stringify(first.progress), /credential|Private upstream/);
  const calls = clone(f.calls); await collectSonicCatalogScoutCoverageProbe({ ...f.deps, progress: first.progress }); assert.deepEqual(f.calls, calls);
});
test("interrupted global attempts are skipped on resume, including across the shared requests", async () => {
  const f = fixture(); let interrupted = false;
  f.deps.persistProgress = async p => { f.persisted.push(clone(p)); if (!interrupted && p.attempts.some(a => a.role === "candidate" && a.status === "started")) {
    interrupted = true; throw Error("Simulated durable interruption"); } };
  await assert.rejects(() => collectSonicCatalogScoutCoverageProbe(f.deps), /durable interruption/);
  const saved = f.persisted.at(-1), lost = saved.attempts.find(a => a.status === "started"); f.deps.persistProgress = async p => f.persisted.push(clone(p));
  const result = await collectSonicCatalogScoutCoverageProbe({ ...f.deps, progress: saved }); assert.equal(result.complete, true);
  assert.equal(result.progress.attempts.filter(a => a.beatportTrackId === lost.beatportTrackId).length, 1);
  assert.equal(f.calls.previews.some(p => p.id === lost.beatportTrackId), false);
});
test("source attempts stop at forty-eight per genre and ninety-six globally, with no adaptive retries", async () => {
  const f = fixture(), search = f.deps.tidal.searchTracks;
  f.deps.tidal.searchTracks = async (query, options) => { const id = query.match(/Source (\d+)/)?.[1];
    if (["1006", "1106", "2006", "2106"].includes(id)) return search(query, options);
    f.calls.searches.push({ query, options: clone(options) }); return []; };
  const result = await collectSonicCatalogScoutCoverageProbe(f.deps); assert.equal(result.complete, false); assert.equal(result.progress.attempts.length, 96);
  for (const id of ["91", "92"]) assert.equal(result.progress.attempts.filter(a => a.genreId === id).length, 48);
  assert.ok(result.progress.attempts.every(a => a.tidalQueries.length <= 3 && a.canonicalLookups.length <= 3));
  const calls = clone(f.calls); await collectSonicCatalogScoutCoverageProbe({ ...f.deps, progress: result.progress }); assert.deepEqual(f.calls, calls);
});
test("canonical lookups stay capped at three per source across all search queries", async () => {
  const f = fixture(); f.deps.tidal.searchTracks = async (query, options) => { f.calls.searches.push({ query, options }); const id = query.match(/Source (\d+)/)?.[1];
    return id ? Array.from({ length: 12 }, (_, i) => ({ id: String(9000000 + Number(id) * 12 + i), artist: f.exact(id).artist, title: f.exact(id).title })) : []; };
  f.deps.tidal.getTrack = async id => { f.calls.details.push(id); throw Error("Upstream secret body must never be copied"); };
  const result = await collectSonicCatalogScoutCoverageProbe(f.deps); assert.equal(result.complete, false);
  assert.ok(result.progress.attempts.every(a => a.canonicalLookups.length === 3));
  assert.doesNotMatch(JSON.stringify(result.progress), /Upstream secret/);
});
test("corrupt resumed evidence or altered fixed budgets fail before providers", async () => {
  const f = fixture(), first = await collectSonicCatalogScoutCoverageProbe(f.deps), calls = clone(f.calls);
  for (const alter of [p => { p.requestSha256 = "a".repeat(64); }, p => { p.pages[0].rows[0].genreId = "92"; },
    p => { p.entries[0].source.spans[0][0]++; }, p => { p.attempts.push(clone(p.attempts[0])); }]) {
    const progress = clone(first.progress); alter(progress);
    await assert.rejects(() => collectSonicCatalogScoutCoverageProbe({ ...f.deps, progress })); assert.deepEqual(f.calls, calls);
  }
  const request = clone(f.request); request.recipe.maxSources = 17;
  await assert.rejects(() => collectSonicCatalogScoutCoverageProbe({ ...f.deps, request })); assert.deepEqual(f.calls, calls);
});
