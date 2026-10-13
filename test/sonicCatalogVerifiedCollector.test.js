"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { normalizeBeatportTrack } = require("../src/beatportClient");
const { VERIFIED_COLLECTOR_RECIPE, VERIFIED_COLLECTOR_REQUESTS, validateVerifiedCollectionBreadth,
  collectSonicCatalogVerifiedPool } = require("../src/sonicCatalogVerifiedCollector");
const clone = value => structuredClone(value), hash = value => createHash("sha256").update(value).digest("hex");
function fixture() {
  const request = { version: 1, recipe: { ...VERIFIED_COLLECTOR_RECIPE }, requests: clone(VERIFIED_COLLECTOR_REQUESTS), excludedBeatportTrackIds: [], excluded: [], excludedSourceSha256: [],
    heldOut: Array.from({ length: 6 }, (_, i) => ({ identityKey: "text:reserved-" + i, artist: "Reserved " + i, title: "Reserved title " + i })) };
  const pages = new Map(), byId = new Map(), audio = new Map(), calls = { pages: [], searches: [], details: [], previews: [], saves: [], timeline: [] };
  const state = { last: null };
  for (const genre of ["91", "92"]) for (const pageNumber of [2, 3, 4]) {
    const name = genre === "91" ? "Bass House" : "Techno (Raw / Deep / Hypnotic)", start = genre === "91" ? 1000 : 2000;
    const rows = Array.from({ length: 100 }, (_, i) => {
      const id = String(start + (pageNumber - 2) * 100 + i), releaseId = String(500000 + Math.floor(Number(id) / 2));
      const raw = { id, name: "Source " + id, mix_name: "Original Mix", artists: [{ id: String(100000 + Number(id)), name: "Artist " + id }], genre: { id: Number(genre), name },
        release: { id: releaseId, name: "Album " + releaseId, label: { name: "Label " + id }, publish_date: "2020-01-01" }, isrc: "GBKQU20" + id.padStart(5, "0"),
        bpm: 128, length_ms: 360000, sample_url: "https://private-fixture.invalid/preview?secret=" + id };
      byId.set(id, raw); return normalizeBeatportTrack(raw);
    }); pages.set(genre + ":" + pageNumber, rows.reverse());
  }
  const exact = id => { const raw = byId.get(String(id)); return { id: String(1000000 + Number(id)), artist: raw.artists.map(row => row.name).join(", "), title: raw.name,
    mixVersion: raw.mix_name, album: raw.release.name, label: raw.release.label.name, isrc: raw.isrc, durationMs: raw.length_ms, year: 2020, releaseDate: "2020-01-01" }; };
  const queryId = query => query.match(/source (\d+)/i)?.[1];
  const deps = { request, requestSha256: hash(JSON.stringify(request)), now: () => "2026-10-08T00:00:00.000Z",
    beatport: { pagedTracks: async (pathname, options) => { calls.pages.push({ pathname, ...clone(options) }); calls.timeline.push("page"); return { tracks: clone(pages.get(options.params.genre_id + ":" + options.page)), pages: [{}] }; },
      fetchPreviewBuffer: async (row, options) => { assert.match(row.previewUrl, /^https:\/\/private-fixture/); calls.previews.push({ id: row.id, options }); calls.timeline.push("preview"); return { buffer: Buffer.from("audio-" + row.id) }; } },
    tidal: { searchTracks: async (query, options) => { calls.searches.push({ query, options: clone(options) }); calls.timeline.push("search"); const id = queryId(query); return id ? [{ id: exact(id).id, artist: exact(id).artist, title: exact(id).title }] : []; },
      getTrack: async id => { calls.details.push(id); calls.timeline.push("detail"); return exact(String(Number(id) - 1000000)); } },
    saveAudio: async (bytes, info) => { assert.equal(hash(bytes), info.sourceSha256); const file = "private/" + info.sourceSha256 + ".audio"; audio.set(file, Buffer.from(bytes)); calls.saves.push(clone(info)); return file; },
    probeDuration: async file => { assert.ok(audio.has(file)); return 120.032653; }, persistProgress: async progress => { state.last = clone(progress); } };
  return { request, deps, calls, pages, byId, audio, state, exact, queryId };
}
function mutateRaw(f, key, id, alter) {
  const raw = f.byId.get(id); alter(raw);
  const rows = f.pages.get(key), index = rows.findIndex(row => row.id === id); rows[index] = normalizeBeatportTrack(raw);
}
test("freezes six fixed plain catalogue pages before any source and supplies sixteen exact diverse sources", async () => {
  const f = fixture(), before = clone(f.request), result = await collectSonicCatalogVerifiedPool(f.deps);
  assert.equal(result.complete, true); assert.equal(result.progress.closed, true); assert.equal(result.pool.entries.length, 16); assert.deepEqual(f.request, before);
  assert.deepEqual(f.calls.timeline.slice(0, 6), ["page", "page", "page", "page", "page", "page"]); assert.equal(f.calls.pages.length, 6);
  assert.deepEqual(f.calls.pages.map(row => row.params.genre_id + ":" + row.page), ["91:2", "91:3", "91:4", "92:2", "92:3", "92:4"]);
  assert.ok(f.calls.pages.every(row => [2, 3, 4].includes(row.page) && row.perPage === 100 && row.maxPages === 1)); assert.equal(f.calls.previews.length, 16); assert.equal(f.calls.details.length, 16);
  assert.deepEqual(f.calls.previews.slice(0, 8).map(row => row.id), ["1000", "1002", "1004", "1006", "1008", "1010", "1012", "1014"]);
  const breadth = validateVerifiedCollectionBreadth(result.progress);
  assert.ok(breadth.genres.every(row => row.anchors === 2 && row.candidates === 6 && row.distinctBeatportReleases === 8 && row.distinctCanonicalAlbums === 8 && row.distinctArtistIds === 8));
  assert.equal(result.pool.samplingScope, "two-genre"); assert.equal(result.pool.requests.length, 4);
  for (const [a, b] of [[0, 1], [2, 3]]) { assert.notEqual(result.pool.requests[a].anchorIdentityKey, result.pool.requests[b].anchorIdentityKey); assert.deepEqual(result.pool.requests[a].candidateIdentityKeys, result.pool.requests[b].candidateIdentityKeys); }
  for (const row of result.pool.requests) { assert.equal(row.options.genre, undefined); assert.equal(row.options.genres, undefined); assert.equal(row.options.count, 3); }
  for (const entry of result.pool.entries) { assert.equal(entry.source.sourceSha256, hash(f.audio.get(entry.sourceFile))); assert.equal(entry.source.identityRelation, "exact"); assert.equal(entry.source.allowVersionProxy, false); }
  assert.ok(f.calls.searches.every(row => row.options.limit === 20 && row.options.detailLimit === 0 && row.options.pageCount === 1 && row.options.rotateCatalog === false));
  assert.doesNotMatch(JSON.stringify(result.progress), /https?:|private-fixture|secret|Misleading Top100/);
});
test("rejects repeated canonical album families and overlapping numeric artist identities before audio", async () => {
  const f = fixture(), get = f.deps.tidal.getTrack;
  f.deps.tidal.getTrack = async id => { const row = await get(id); if (id === "1001002") row.album = "Album 500500 (Deluxe Edition)"; return row; };
  mutateRaw(f, "91:2", "1004", raw => { raw.artists = [{ id: "101000", name: "Artist 1004" }]; });
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, true);
  assert.ok(!f.calls.previews.some(row => ["1002", "1004"].includes(row.id)));
  assert.equal(result.progress.attempts.find(row => row.beatportTrackId === "1002").reason, "accepted-canonical-album-overlap");
  assert.ok(result.progress.genres[0].breadthRejections["accepted-artist-id-overlap"] > 0);
});
test("different track artists on the same album cannot fill the breadth gate", async () => {
  const f = fixture(); for (const [key, rows] of f.pages) if (key.startsWith("91:")) for (const row of rows) { row.rawJson.release.id = "9999"; row.rawJson.release.name = "One compilation"; Object.assign(row, normalizeBeatportTrack(row.rawJson)); }
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, false); assert.equal(result.pool, null);
  assert.equal(result.progress.genres[0].anchorIdentityKeys.length, 1); assert.equal(result.progress.genres[0].candidateIdentityKeys.length, 0);
  assert.equal(result.progress.entries.length, 9); assert.throws(() => validateVerifiedCollectionBreadth(result.progress), /Both genres/);
});
test("wrong actual genre, missing release identity, invalid dates and future rows never trigger exact attempts", async () => {
  const f = fixture();
  mutateRaw(f, "91:2", "1000", raw => { raw.genre.id = 92; });
  mutateRaw(f, "91:2", "1002", raw => { delete raw.release.id; });
  mutateRaw(f, "91:2", "1004", raw => { raw.release.publish_date = "2026-10-09"; });
  mutateRaw(f, "91:2", "1006", raw => { raw.release.publish_date = "2026-02-31"; });
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, true);
  assert.equal(result.progress.pages[0].rejected["malformed-wrong-genre-or-unreleased-row"], 4);
  assert.ok(!result.progress.attempts.some(row => ["1000", "1002", "1004", "1006"].includes(row.beatportTrackId)));
});
test("missing search ISRC/version reaches exact detail; conflicting search identity is rejected", async () => {
  const f = fixture(), search = f.deps.tidal.searchTracks;
  f.deps.tidal.searchTracks = async (query, options) => { const rows = await search(query, options), id = f.queryId(query);
    if (id === "1000") rows.forEach(row => { row.isrc = "WRONGISRC"; });
    if (id === "1002") rows.forEach(row => { row.mixVersion = "Other Remix"; });
    if (id === "1004") rows.forEach(row => { row.artist = "Other Artist"; }); return rows; };
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, true);
  assert.ok(!f.calls.details.some(id => ["1001000", "1001002", "1001004"].includes(id)));
  assert.ok(f.calls.details.includes("1001006"));
  assert.ok(!f.calls.searches.some(row => /^GBKQU/.test(row.query)));
  assert.deepEqual(result.progress.attempts[0].tidalQueries.map(row => row.query), ["Artist 1000 Source 1000 Original Mix", "Artist 1000 source 1000", "source 1000 Original Mix"]);
});
test("proved unlabeled originals preserve v2 equivalence while canonical conflicts never reach audio", async () => {
  const f = fixture(), get = f.deps.tidal.getTrack;
  f.deps.tidal.getTrack = async id => { const row = await get(id); if (id === "1001000") delete row.mixVersion; if (id === "1001002") row.isrc = "WRONGISRC"; if (id === "1001004") row.id = "9999999"; return row; };
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, true);
  assert.ok(f.calls.previews.some(row => row.id === "1000"));
  assert.ok(!f.calls.previews.some(row => ["1002", "1004"].includes(row.id)));
  const admitted = result.progress.attempts.find(row => row.beatportTrackId === "1000"), source = result.pool.entries.find(row => row.track.identityKey === "tidal:1001000").source;
  assert.equal(admitted.status, "frozen-verified"); assert.equal(admitted.canonicalLookups[0].diagnostic.classification, "verified-equivalent");
  assert.equal(admitted.canonicalLookups[0].admission.version, 2); assert.equal(source.version, 2);
  assert.equal(source.identityRelation, "equivalent-recording"); assert.equal(source.equivalenceProof.relation, "ORIGINAL_EQUIVALENT_TO_UNLABELED");
  assert.equal(source.sourceTrack.mixName, "Original Mix"); assert.equal(source.canonicalTrack.mixVersion, undefined);
  const rejected = result.progress.attempts.find(row => row.beatportTrackId === "1002").canonicalLookups[0];
  assert.equal(rejected.diagnostic.classification, "rejected"); assert.equal(rejected.diagnostic.tidal.isrcMatch, false);
  assert.equal(rejected.reason, "isrc-conflict"); assert.equal(rejected.admission.proof, null);
  assert.equal(result.progress.attempts.find(row => row.beatportTrackId === "1004").canonicalLookups[0].stage, "detail");
});
test("unlabeled originals without every independent proof remain blocked before preview", async () => {
  const f = fixture(), get = f.deps.tidal.getTrack;
  const changes = new Map([["1001000", row => { row.durationMs += 1001; }], ["1001002", row => { row.label = "Other label"; }],
    ["1001004", row => { row.album = "Other album"; }], ["1001006", row => { row.releaseDate = "2020-01-02"; }],
    ["1001008", row => { delete row.isrc; }], ["1001010", row => { row.mixVersion = "Radio Edit"; }]]);
  f.deps.tidal.getTrack = async id => { const row = await get(id); if (changes.has(id)) { delete row.mixVersion; changes.get(id)(row); } return row; };
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, true);
  for (const [tidalId] of changes) {
    const sourceId = String(Number(tidalId) - 1000000), attempt = result.progress.attempts.find(row => row.beatportTrackId === sourceId);
    assert.ok(attempt); assert.ok(!f.calls.previews.some(row => row.id === sourceId)); assert.equal(attempt.stage, "identity");
    assert.ok(attempt.canonicalLookups[0].diagnostic); assert.equal(attempt.canonicalLookups[0].diagnostic.canonicalTrack.tidalId, tidalId);
  }
  assert.equal(result.progress.attempts.find(row => row.beatportTrackId === "1000").canonicalLookups[0].diagnostic.tidal.durationDeltaMs, 1001);
  assert.equal(result.progress.attempts.find(row => row.beatportTrackId === "1002").canonicalLookups[0].admission.accepted, false);
});
test("all prior attempts, heldouts, previous recordings and audio hashes remain excluded", async () => {
  const f = fixture(); f.request.excludedBeatportTrackIds = ["1000"];
  f.request.heldOut[0] = { identityKey: "tidal:1001002", artist: "Artist 1002", title: "Source 1002", isrc: "GBKQU2001002" };
  f.request.excluded = [{ identityKey: "tidal:1001004", artist: "Artist 1004", title: "Source 1004" }];
  f.request.excludedSourceSha256 = [hash(Buffer.from("audio-1006"))]; f.deps.requestSha256 = hash(JSON.stringify(f.request));
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, true);
  assert.ok(!result.progress.attempts.some(row => row.beatportTrackId === "1000"));
  assert.ok(!f.calls.previews.some(row => ["1002", "1004"].includes(row.id))); assert.ok(!f.calls.saves.some(row => row.beatportTrackId === "1006"));
  assert.ok(!result.pool.entries.some(row => ["tidal:1001000", "tidal:1001002", "tidal:1001004", "tidal:1001006"].includes(row.track.identityKey)));
});
test("provider metadata, preview, storage, probe and source freezing fail with safe stage-specific receipts", async () => {
  const f = fixture(), preview = f.deps.beatport.fetchPreviewBuffer, save = f.deps.saveAudio, probe = f.deps.probeDuration;
  f.deps.beatport.pagedTracks = async (pathname, options) => { f.calls.pages.push({ pathname, ...options }); if (options.params.genre_id === "92" && options.page === 4) throw Error("TOKEN https://private.invalid"); return { tracks: clone(f.pages.get(options.params.genre_id + ":" + options.page)) }; };
  f.deps.beatport.fetchPreviewBuffer = async (row, options) => { if (row.id === "1000") throw Error("TOKEN https://signed.invalid"); return preview(row, options); };
  f.deps.saveAudio = async (bytes, info) => { if (info.beatportTrackId === "1002") throw Error("TOKEN storage path"); return save(bytes, info); };
  f.deps.probeDuration = async file => { const bytes = f.audio.get(file); if (bytes.equals(Buffer.from("audio-1004"))) return 29; if (bytes.equals(Buffer.from("audio-1006"))) { bytes.fill(0); return probe(file); } return probe(file); };
  // A provider can mutate the submitted bytes while storage runs; freezing catches it.
  f.deps.saveAudio = async (bytes, info) => { if (info.beatportTrackId === "1002") throw Error("TOKEN storage path"); const file = await save(bytes, info); if (info.beatportTrackId === "1008") bytes.fill(0); return file; };
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, true);
  assert.equal(result.progress.pages[5].stage, "metadata");
  for (const [id, stage] of [["1000", "preview"], ["1002", "freeze"], ["1004", "probe"], ["1008", "freeze"]]) assert.equal(result.progress.attempts.find(row => row.beatportTrackId === id).stage, stage);
  assert.doesNotMatch(JSON.stringify(result.progress), /TOKEN|https?:|signed.invalid|storage path/);
});
test("exact attempts stop at eighty per genre and one hundred sixty total", async () => {
  const f = fixture(); f.deps.tidal.searchTracks = async (query, options) => { f.calls.searches.push({ query, options }); return []; };
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, false); assert.equal(result.pool, null); assert.equal(result.progress.attempts.length, 160);
  for (const genreId of ["91", "92"]) assert.equal(result.progress.attempts.filter(row => row.genreId === genreId).length, 80);
  assert.ok(result.progress.attempts.every(row => row.tidalQueries.length === 3)); assert.equal(f.calls.searches.length, 480);
  assert.equal(new Set(result.progress.attempts.map(row => row.beatportTrackId)).size, 160);
});
test("canonical detail lookups are capped across all three searches and raw errors are not saved", async () => {
  const f = fixture(); f.deps.tidal.searchTracks = async (query, options) => { f.calls.searches.push({ query, options }); const id = f.queryId(query); return Array.from({ length: 30 }, (_, i) => ({ ...f.exact(id), id: String(9000000 + Number(id) * 30 + i) })); };
  f.deps.tidal.getTrack = async id => { f.calls.details.push(id); throw Error("private auth header"); };
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, false);
  assert.ok(result.progress.attempts.every(row => row.canonicalLookups.length === 3 && row.tidalQueries.length === 1 && row.tidalQueries[0].candidateCount === 20));
  assert.equal(f.calls.details.length, 480); assert.doesNotMatch(JSON.stringify(result.progress), /private auth header/);
});
test("closed successful and incomplete snapshots replay without any provider calls; tampering fails", async () => {
  const f = fixture(), first = await collectSonicCatalogVerifiedPool(f.deps), before = clone(f.calls);
  const replay = await collectSonicCatalogVerifiedPool({ ...f.deps, progress: first.progress }); assert.deepEqual(replay, first); assert.deepEqual(f.calls, before);
  for (const change of [p => { p.requestSha256 = "a".repeat(64); }, p => { p.pages[0].rows[0].releaseId = "999"; }, p => { p.breadth[0].beatportReleaseId = p.breadth[1].beatportReleaseId; },
    p => { p.breadth[0].canonicalAlbumFamily = "fabricated"; }, p => { p.breadth[0].artistIds = p.breadth[1].artistIds; }, p => { p.entries[0].source.spans[0][0]++; }, p => { p.attempts.push(clone(p.attempts[0])); },
    p => { const row = p.pages[0].rows[0]; row.isrc = "GBKQU2099999"; const { catalogRecordKey, ...body } = row; row.catalogRecordKey = hash(JSON.stringify(body)); }]) {
    const progress = clone(first.progress); change(progress); await assert.rejects(() => collectSonicCatalogVerifiedPool({ ...f.deps, progress })); assert.deepEqual(f.calls, before);
  }
  const g = fixture(); g.deps.beatport.pagedTracks = async (pathname, options) => { g.calls.pages.push({ pathname, ...options }); throw Error("private upstream"); };
  const incomplete = await collectSonicCatalogVerifiedPool(g.deps), calls = clone(g.calls);
  assert.equal(incomplete.complete, false); assert.equal((await collectSonicCatalogVerifiedPool({ ...g.deps, progress: incomplete.progress })).complete, false); assert.deepEqual(g.calls, calls);
});
test("durable interruption is propagated and cannot silently refetch pages or retry attempts", async () => {
  const f = fixture(); f.deps.persistProgress = async progress => { f.state.last = clone(progress); if (progress.attempts.length) throw Error("durable interruption"); };
  await assert.rejects(() => collectSonicCatalogVerifiedPool(f.deps), /durable interruption/);
  const calls = clone(f.calls); f.deps.persistProgress = async () => {};
  await assert.rejects(() => collectSonicCatalogVerifiedPool({ ...f.deps, progress: f.state.last }), /Interrupted collections/); assert.deepEqual(f.calls, calls);
});
test("conflicting repeated catalogue IDs cannot borrow a clean row from the other feed", async () => {
  const f = fixture(), old = clone(f.pages.get("91:2").find(row => row.id === "1000")); old.rawJson.name = "Conflicting title"; Object.assign(old, normalizeBeatportTrack(old.rawJson));
  f.pages.get("91:3").push(old); f.pages.get("91:3").shift();
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, true);
  assert.deepEqual(result.progress.genres[0].conflictingTrackIds, ["1000"]); assert.ok(!result.progress.attempts.some(row => row.beatportTrackId === "1000"));
});
test("conflicting repeated IDs within one page are removed rather than accepting whichever row arrived first", async () => {
  const f = fixture(), old = clone(f.pages.get("91:2").find(row => row.id === "1000")); old.rawJson.name = "Conflicting title"; Object.assign(old, normalizeBeatportTrack(old.rawJson));
  f.pages.get("91:2").unshift(old); f.pages.get("91:2").splice(1, 1);
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.complete, true);
  assert.equal(result.progress.pages[0].rejected["conflicting-catalogue-identity"], 1); assert.ok(!result.progress.attempts.some(row => row.beatportTrackId === "1000"));
});
test("changed declared budgets fail before any provider operation", async () => {
  const f = fixture(); for (const key of ["maxSourceAttempts", "maxSourceAttemptsPerGenre", "maxTidalQueriesPerSource", "maxResultsPerPage", "maxSources", "distinctCanonicalAlbumsPerGenre"]) {
    const request = clone(f.request); request.recipe[key]++; await assert.rejects(() => collectSonicCatalogVerifiedPool({ ...f.deps, request }));
  } assert.equal(f.calls.pages.length, 0);
});
test("the completed pool passes the new v7 verified-source and collection ownership validator", async t => {
  const { validatePool } = require("../src/sonicCatalogVerifiedReview"), f = fixture(), get = f.deps.tidal.getTrack;
  f.deps.tidal.getTrack = async id => { const row = await get(id); if (id === "1001000") delete row.mixVersion; return row; };
  const result = await collectSonicCatalogVerifiedPool(f.deps); assert.equal(result.pool.entries[0].source.version, 2);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sonic-verified-collector-")), data = path.join(directory, "data"); fs.mkdirSync(data);
  t.after(() => { const relative = path.relative(os.tmpdir(), directory); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative)); fs.rmSync(directory, { recursive: true, force: true }); });
  const pool = clone(result.pool), progress = clone(result.progress);
  for (const entry of pool.entries) { const bytes = f.audio.get(entry.sourceFile), file = path.join(data, entry.source.sourceSha256 + ".audio"); fs.writeFileSync(file, bytes); entry.sourceFile = file; progress.entries.find(row => row.track.identityKey === entry.track.identityKey).sourceFile = file; }
  const bind = (name, value) => { const file = path.join(data, name); fs.writeFileSync(file, JSON.stringify(value)); return { file, sha256: hash(fs.readFileSync(file)) }; };
  const declaration = bind("request.json", f.request); progress.requestSha256 = declaration.sha256;
  const collection = bind("collection.json", progress); pool.collectionEvidence = bind("collection-evidence.json", { version: 1, kind: "catalog-fresh-combined-evidence", runs: [{ declaration, collection }] });
  assert.equal(validatePool(pool, { artifactRoot: directory, requireBytes: true }).entries.size, 16);
});
