"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const { normalizeBeatportTrack } = require("../src/beatportClient"), { TidalVerifier } = require("../src/tidalVerifier");
const { DIAGNOSTIC_RECIPE, collectSourcingDiagnostic, matcherDiagnostic, configureTidalNoRetry } = require("../scripts/sonic-catalog-sourcing-diagnostic");
const clone = value => structuredClone(value), hash = value => createHash("sha256").update(value).digest("hex");
function fixture() {
  const request = { version: 1, recipe: clone(DIAGNOSTIC_RECIPE), excludedBeatportTrackIds: [], excluded: [],
    heldOut: Array.from({ length: 6 }, (_, i) => ({ identityKey: "text:reserved-" + i, artist: "Reserved " + i, title: "Reserved " + i })) };
  const pages = new Map(), byId = new Map(), calls = { charts: [], pages: [], searches: [], details: [], timeline: [] }, state = { last: null };
  for (const genre of ["91", "92"]) for (const chartId of ["11", "21"]) {
    const start = (genre === "91" ? 1000 : 2000) + (chartId === "21" ? 100 : 0), name = genre === "91" ? "Bass House" : "Techno (Raw / Deep / Hypnotic)";
    const tracks = Array.from({ length: 50 }, (_, i) => { const id = String(start + i), releaseId = String(90000 + Math.floor(Number(id) / 2));
      const raw = { id, name: "Signal " + id, mix_name: "Original Mix", artists: [{ id: String(70000 + Number(id)), name: "Artist " + id }], genre: { id: Number(genre), name },
        release: { id: releaseId, name: "Album " + releaseId, label: { name: "Label " + id }, publish_date: "2020-01-01" }, isrc: "USAAA20" + id, length_ms: 360000,
        sample_url: "https://private.invalid/signed?token=SECRET" }; byId.set(id, raw); return normalizeBeatportTrack(raw); });
    pages.set(genre + ":" + chartId, tracks.reverse());
  }
  const exact = id => { const raw = byId.get(String(id)); return { id: String(1000000 + Number(id)), title: raw.name, artist: raw.artists[0].name, mixVersion: raw.mix_name,
    album: raw.release.name, label: raw.release.label.name, isrc: raw.isrc, durationMs: raw.length_ms, year: 2020, releaseDate: "2020-01-01" }; };
  let genreForTracks = "91", tracksCallCount = 0;
  const deps = { request, requestSha256: hash(JSON.stringify(request)), now: () => "2026-10-09T00:00:00Z",
    beatport: { getCharts: async options => { calls.charts.push(clone(options)); calls.timeline.push("chart"); return { charts: [{ id: "31", title: "Third" }, { id: "21", title: "Second" }, { id: "bad", title: "Invalid" }, { id: "11", title: "First" }], pagination: { count: 4 } }; },
      pagedTracks: async (pathname, options) => { calls.pages.push({ pathname, options: clone(options) }); calls.timeline.push("page"); genreForTracks = tracksCallCount++ < 2 ? "91" : "92"; const id = pathname.match(/charts\/(\d+)/)[1]; return { tracks: clone(pages.get(genreForTracks + ":" + id)), pages: [{}], next: "https://ignored.invalid/page2" }; },
      getChart: () => { throw Error("Do not call unbounded charts"); }, fetchPreviewBuffer: () => { throw Error("No audio permitted"); } },
    tidal: { searchTracks: async (query, options) => { calls.searches.push({ query, options: clone(options) }); calls.timeline.push("search"); const id = query.match(/signal (\d+)/i)?.[1]; return id ? [{ id: exact(id).id, artist: exact(id).artist, title: exact(id).title }] : []; },
      getTrack: async id => { calls.details.push(id); return exact(String(Number(id) - 1000000)); } },
    persistProgress: async value => { state.last = clone(value); } };
  return { request, deps, calls, pages, byId, exact, state };
}
test("six genuine chart metadata calls settle before sixteen new bounded identity attempts", async () => {
  const f = fixture(), before = clone(f.request), result = await collectSourcingDiagnostic(f.deps);
  assert.equal(result.closed, true); assert.equal(result.metadataGate, true); assert.deepEqual(f.request, before);
  assert.deepEqual(f.calls.timeline.slice(0, 6), ["chart", "chart", "page", "page", "page", "page"]);
  assert.equal(f.calls.charts.length, 2); assert.ok(f.calls.charts.every(call => call.source === "genre" && call.page === 1 && call.perPage === 6));
  assert.equal(f.calls.pages.length, 4); assert.ok(f.calls.pages.every(call => call.options.page === 1 && call.options.perPage === 50 && call.options.maxPages === 1));
  assert.deepEqual(result.chartListings[0].charts.map(chart => chart.id), ["11", "21"]);
  assert.equal(result.attempts.length, 16); assert.ok(result.summary.genres.every(genre => genre.attempts === 8 && genre.classifications["strict-exact"] === 8));
  assert.deepEqual(result.attempts.slice(0, 8).map(attempt => attempt.beatportTrackId), ["1000", "1002", "1004", "1006", "1008", "1010", "1012", "1014"]);
  assert.ok(f.calls.searches.every(call => call.options.limit === 20 && call.options.detailLimit === 0 && call.options.pageCount === 1 && call.options.rotateCatalog === false));
  assert.equal(result.audioDownloads, 0); assert.equal(result.modelRuns, 0); assert.equal(result.reviewPairs, 0); assert.equal(result.productionApplied, false);
  assert.doesNotMatch(JSON.stringify(result), /https?:|SECRET|sample_url|rawJson|ignored.invalid/);
});
test("strict exact, strongly verified equivalent and rejected canonical records remain separate", () => {
  const f = fixture(), raw = normalizeBeatportTrack(f.byId.get("1000")), canonical = { ...f.exact("1000"), tidalId: f.exact("1000").id, identityKey: "tidal:" + f.exact("1000").id };
  const requested = { artist: raw.artist, title: raw.title, mixVersion: raw.mixName, album: raw.album, isrc: raw.isrc, durationMs: raw.durationMs, label: raw.label, releaseDate: raw.releaseDate };
  const exact = matcherDiagnostic(requested, canonical, raw); assert.equal(exact.classification, "strict-exact"); assert.equal(exact.sourceCorpusEligible, true);
  const unlabeled = clone(canonical); delete unlabeled.mixVersion;
  const equivalent = matcherDiagnostic(requested, unlabeled, raw); assert.equal(equivalent.classification, "verified-equivalent"); assert.equal(equivalent.beatport.relation, "equivalent-recording"); assert.equal(equivalent.sourceCorpusEligible, false);
  assert.equal(equivalent.tidal.matched, true); assert.equal(equivalent.beatport.matched, true);
  const conflict = { ...canonical, isrc: "DIFFERENT" }, rejected = matcherDiagnostic(requested, conflict, raw);
  assert.equal(rejected.classification, "rejected"); assert.equal(rejected.coarseReason, "isrc-conflict"); assert.equal(rejected.tidal.isrcMatch, false); assert.equal(rejected.sourceCorpusEligible, false);
});
test("canonical detail classification preserves conflict diagnostics rather than accepting missing search evidence", async () => {
  const f = fixture(), get = f.deps.tidal.getTrack;
  f.deps.tidal.getTrack = async id => { const track = await get(id); if (id === "1001000") delete track.mixVersion; if (id === "1001002") track.isrc = "DIFFERENT"; if (id === "1001004") track.mixVersion = "Different Named Remix"; return track; };
  const result = await collectSourcingDiagnostic(f.deps);
  assert.equal(result.attempts.find(attempt => attempt.beatportTrackId === "1000").classification, "verified-equivalent");
  for (const id of ["1002", "1004"]) { const diagnostic = result.attempts.find(attempt => attempt.beatportTrackId === id).canonicalLookups[0].diagnostic; assert.equal(diagnostic.classification, "rejected"); assert.ok(diagnostic.canonicalTrack.isrc); assert.equal(diagnostic.sourceCorpusEligible, false); }
});
test("prior attempted Beatport IDs, exposed recordings and all heldouts are rejected without audio", async () => {
  const f = fixture(); f.request.excludedBeatportTrackIds = ["1000", "2000"];
  f.request.excluded = [{ identityKey: "tidal:1001002", artist: "Artist 1002", title: "Signal 1002" }];
  f.request.heldOut[0] = { identityKey: "tidal:1001004", artist: "Artist 1004", title: "Signal 1004", isrc: "USAAA201004" }; f.deps.requestSha256 = hash(JSON.stringify(f.request));
  const result = await collectSourcingDiagnostic(f.deps); assert.equal(result.attempts.length, 16);
  assert.ok(!result.attempts.some(attempt => ["1000", "2000"].includes(attempt.beatportTrackId)));
  for (const id of ["1002", "1004"]) { const lookup = result.attempts.find(attempt => attempt.beatportTrackId === id).canonicalLookups[0]; assert.equal(lookup.status, "excluded"); assert.equal(lookup.diagnostic, undefined); }
});
test("incorrect actual genres, nonnumeric release IDs, conflicting source IDs and future dates do not receive queries", async () => {
  const f = fixture(); const mutations = { "1000": raw => { raw.genre.id = 92; }, "1002": raw => { raw.release.id = "missing"; }, "1004": raw => { raw.track_id = "99999"; }, "1006": raw => { raw.release.publish_date = "2026-10-10"; } };
  for (const [id, mutate] of Object.entries(mutations)) { const raw = f.byId.get(id); mutate(raw); const rows = f.pages.get("91:11"); rows[rows.findIndex(row => row.id === id)] = normalizeBeatportTrack(raw); }
  const result = await collectSourcingDiagnostic(f.deps); assert.equal(result.pages[0].rejected["invalid-wrong-genre-or-unreleased"], 4);
  assert.ok(!result.attempts.some(attempt => Object.hasOwn(mutations, attempt.beatportTrackId)));
});
test("up to twenty search rows and three details are consumed per source across at most three searches", async () => {
  const f = fixture(); f.deps.tidal.searchTracks = async (query, options) => { f.calls.searches.push({ query, options }); const id = query.match(/signal (\d+)/i)?.[1]; return Array.from({ length: 50 }, (_, i) => ({ id: String(9000000 + Number(id) * 50 + i), artist: f.exact(id).artist, title: f.exact(id).title })); };
  f.deps.tidal.getTrack = async id => { f.calls.details.push(id); throw Error("TOKEN https://private.invalid"); };
  const result = await collectSourcingDiagnostic(f.deps); assert.equal(result.attempts.length, 16); assert.equal(f.calls.details.length, 48);
  assert.ok(result.attempts.every(attempt => attempt.canonicalLookups.length === 3 && attempt.tidalQueries.length === 1 && attempt.tidalQueries[0].candidateCount === 20));
  assert.doesNotMatch(JSON.stringify(result), /TOKEN|https?:/);
});
test("unavailable searches remain bounded to three per source and no raw errors are persisted", async () => {
  const f = fixture(); f.deps.tidal.searchTracks = async (query, options) => { f.calls.searches.push({ query, options }); throw Error("PRIVATE TOKEN"); };
  const result = await collectSourcingDiagnostic(f.deps); assert.equal(result.attempts.length, 16); assert.equal(f.calls.searches.length, 48); assert.equal(f.calls.details.length, 0);
  assert.ok(result.attempts.every(attempt => attempt.tidalQueries.length === 3)); assert.doesNotMatch(JSON.stringify(result), /PRIVATE TOKEN/);
});
test("fewer genuine available charts/pages yield honest partial metadata coverage without fabricated provider calls", async () => {
  const f = fixture(); f.deps.beatport.getCharts = async options => { f.calls.charts.push(options); return { charts: options.genreId === "91" ? [{ id: "11", title: "Only available" }] : [] }; };
  const result = await collectSourcingDiagnostic(f.deps); assert.equal(result.metadataGate, false); assert.equal(f.calls.charts.length, 2); assert.equal(f.calls.pages.length, 1); assert.equal(result.pages.length, 1);
  assert.equal(result.attempts.length, 8); assert.equal(result.summary.genres[1].attempts, 0);
});
test("durable metadata persistence failures propagate before any identity calls", async () => {
  const f = fixture(); f.deps.persistProgress = async value => { f.state.last = clone(value); if (value.pages.length) throw Error("disk persistence failed"); };
  await assert.rejects(() => collectSourcingDiagnostic(f.deps), /disk persistence failed/); assert.equal(f.calls.searches.length, 0);
});
test("changing any fixed source, page or transport budget fails before providers", async () => {
  const f = fixture(); for (const key of ["maximumIdentityAttempts", "maximumIdentityAttemptsPerGenre", "chartTrackMaxPages", "maximumBeatportTransportCalls", "transportRetries", "audioDownloads", "modelRuns"]) { const request = clone(f.request); request.recipe[key]++; await assert.rejects(() => collectSourcingDiagnostic({ ...f.deps, request })); }
  assert.equal(f.calls.charts.length, 0);
});
test("the real TIDAL helper performs no 429, 401 or DNS transport retry in this diagnostic instance", async () => {
  for (const status of [429, 401, "dns"]) {
    let calls = 0, fallbacks = 0;
    const tidal = configureTidalNoRetry(new TidalVerifier({ enabled: true, accessToken: "fixture-token", sleep: async () => {}, fetchImpl: async () => { calls++; if (status === "dns") { const error = Error("private DNS message"); error.code = "EAI_AGAIN"; throw error; } return { status, ok: false, headers: new Headers({ "retry-after": "0" }), json: async () => ({}) }; } }));
    tidal.enableProfileAccessTokenFallback = async () => { fallbacks++; return true; };
    await assert.rejects(() => tidal.fetchTidalJson("https://fixture.invalid/v2/tracks/1")); assert.equal(calls, 1); assert.equal(fallbacks, 0);
  }
});
