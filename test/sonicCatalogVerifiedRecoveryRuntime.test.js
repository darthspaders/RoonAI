"use strict";
// Injected fetch fixtures only; no live providers, private run writes or audio.
const test = require("node:test"), assert = require("node:assert/strict");
const { TidalVerifier } = require("../src/tidalVerifier");
const runtime = require("../scripts/sonic-catalog-scout-verified-recovery");
const SEARCH = "https://openapi.tidal.com/v2/searchResults/fixture/relationships/tracks";
const DETAILS = "https://openapi.tidal.com/v2/tracks/100";
function fixture(fetchImpl, extra = {}) {
  const ledger = { transport: [], tidalTransport: [], tidalRawTransport: [] }, snapshots = [], calls = [];
  const tidal = new TidalVerifier({ enabled: true, accessToken: "private-fixture-token", catalogPaginationFile: "unused-fixture-pagination.json",
    artistAliasFile: "unused-fixture-alias.json", fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); }, ...extra });
  runtime.configureRecoveryTidalTransport(tidal, ledger, () => snapshots.push(structuredClone(ledger)));
  return { tidal, ledger, snapshots, calls };
}
const response = status => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => ({ fixture: true }) });
test("records successful raw fetches separately from logical calls without private locators", async () => {
  const f = fixture(async () => response(200)); await f.tidal.fetchTidalJson(SEARCH + "?private=locator");
  assert.equal(f.calls.length, 1); assert.equal(f.ledger.tidalRawTransport[0].status, 200); assert.equal(f.ledger.tidalRawTransport[0].layer, "raw-fetch");
  assert.equal(f.ledger.tidalTransport[0].status, 200); assert.equal(f.ledger.tidalTransport[0].layer, "logical-request"); assert.equal(f.ledger.infrastructureFailure, undefined);
  assert.doesNotMatch(JSON.stringify(f.snapshots), /private-fixture|authorization|headers|https?:|locator/);
});
test("401, 429 and 5xx stop before a second physical request and preserve actual HTTP status", async () => {
  for (const status of [401, 429, 500, 503]) {
    const f = fixture(async () => response(status)); await assert.rejects(f.tidal.fetchTidalJson(SEARCH));
    assert.equal(f.calls.length, 1); assert.equal(f.ledger.tidalRawTransport[0].status, status);
    assert.equal(f.ledger.tidalTransport[0].status, status); assert.equal(f.ledger.infrastructureFailure.reason, status >= 500 ? "http-5xx" : "http-" + status);
    assert.throws(() => runtime.stopIfInfrastructure(f.ledger), error => error.code === "ECATALOGINFRASTRUCTURE");
    await assert.rejects(f.tidal.fetchTidalJson(SEARCH)); assert.equal(f.calls.length, 1);
  }
});
test("non-2xx search requests stop once even when a 4xx response reaches the logical wrapper", async () => {
  for (const status of [400, 403, 404]) {
    const f = fixture(async () => response(status));
    if (status === 404) assert.equal(await f.tidal.fetchTidalJson(SEARCH), null); else await assert.rejects(f.tidal.fetchTidalJson(SEARCH));
    assert.equal(f.calls.length, 1); assert.equal(f.ledger.tidalRawTransport[0].status, status);
    assert.equal(f.ledger.infrastructureFailure.reason, "search-http-" + status);
    await assert.rejects(f.tidal.fetchTidalJson(SEARCH)); assert.equal(f.calls.length, 1);
  }
});
test("DNS and socket failures save allowlisted causes and neither retry nor fall back", async () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"]) {
    const f = fixture(async () => { const error = new TypeError("private raw message https://secret.invalid"); error.cause = { code, message: "secret locator" }; throw error; });
    await assert.rejects(f.tidal.fetchTidalJson(SEARCH)); assert.equal(f.calls.length, 1);
    assert.equal(f.ledger.tidalRawTransport[0].exception.causeCode, code); assert.equal(f.ledger.infrastructureFailure.reason, "network-or-request-error");
    await assert.rejects(f.tidal.fetchTidalJson(SEARCH)); assert.equal(f.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(f.snapshots), /private raw|secret|https?:|cause.*message/);
  }
});
test("an already open circuit is distinguished from a physical transport failure", async () => {
  const f = fixture(async () => response(200)); f.tidal.circuitBreaker.openUntilMs = Date.now() + 60000;
  await assert.rejects(f.tidal.fetchTidalJson(SEARCH)); assert.equal(f.calls.length, 0); assert.equal(f.ledger.tidalRawTransport.length, 0);
  assert.equal(f.ledger.tidalTransport[0].status, "circuit-open"); assert.equal(f.ledger.tidalTransport[0].exception.code, "ECIRCUITOPEN");
  assert.equal(f.ledger.infrastructureFailure.reason, "circuit-open");
});
test("ordinary canonical-detail 404 stays a bounded per-source rejection", async () => {
  const f = fixture(async () => response(404)); assert.equal(await f.tidal.fetchTidalJson(DETAILS), null); assert.equal(f.ledger.infrastructureFailure, undefined);
  assert.equal(await f.tidal.fetchTidalJson(DETAILS), null); assert.equal(f.calls.length, 2);
  assert.ok(f.ledger.tidalRawTransport.every(row => row.kind === "detail" && row.status === 404));
});
test("failed authentication stops once even when HTTP 200 omits a usable token", async () => {
  for (const status of [200, 400]) {
    const f = fixture(async () => response(status), { accessToken: "", clientId: "private-fixture-id", clientSecret: "private-fixture-secret" });
    await assert.rejects(f.tidal.fetchTidalJson(SEARCH)); assert.equal(f.calls.length, 1); assert.equal(f.ledger.tidalRawTransport[0].kind, "authentication");
    assert.equal(f.ledger.infrastructureFailure.reason, "authentication-unavailable"); await assert.rejects(f.tidal.fetchTidalJson(SEARCH)); assert.equal(f.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(f.snapshots), /private-fixture|authorization|Basic|clientSecret/);
  }
});
test("physical API and authentication caps are enforced before transport", async () => {
  const api = fixture(async () => response(200)); api.ledger.tidalRawTransport = Array.from({ length: 1600 }, () => ({ kind: "detail", status: 200 }));
  await assert.rejects(api.tidal.fetchTidalJson(SEARCH)); assert.equal(api.calls.length, 0);
  const auth = fixture(async () => response(200), { accessToken: "", clientId: "fixture", clientSecret: "fixture" });
  auth.ledger.tidalRawTransport = Array.from({ length: 12 }, () => ({ kind: "authentication", status: 200 }));
  await assert.rejects(auth.tidal.fetchTidalJson(SEARCH)); assert.equal(auth.calls.length, 0);
});
test("safe error fields and infrastructure classifications exclude arbitrary messages and codes", () => {
  const error = new Error("private"); error.code = "SECRET_SHAPED_AS_CODE"; error.cause = { code: "ENOTFOUND" }; error.status = 503;
  assert.deepEqual(runtime.safeException(error), { errorName: "Error", code: "unclassified", causeCode: "ENOTFOUND", httpStatus: 503 });
  assert.equal(runtime.infrastructureReason("detail", 404), null); assert.equal(runtime.infrastructureReason("authentication", 400), "authentication-unavailable");
  assert.equal(runtime.infrastructureReason("search", "transport-error", { code: "ECIRCUITOPEN" }), "circuit-open");
});
test("the additional closed failed run adds 160 prior attempts to the inherited 321 exclusions", () => {
  const original = { heldOut: Array.from({ length: 6 }, (_, i) => ({ identityKey: "tidal:" + (i + 1), artist: "Reserved " + i, title: "Reserved " + i })) };
  original.originalManifest = { items: original.heldOut.map(track => ({ track: { ...track, analysisLocal: { sha256: "a".repeat(64) } } })) };
  const result = runtime.exclusionsFrom([], [{ attempts: Array.from({ length: 160 }, (_, i) => ({ beatportTrackId: String(1000 + i) })), entries: [] }], original,
    [{ excludedBeatportTrackIds: Array.from({ length: 321 }, (_, i) => String(2000 + i)), excluded: [], excludedSourceSha256: [] }]);
  assert.equal(result.excludedBeatportTrackIds.length, 481); assert.equal(result.heldOut.length, 6); assert.equal(result.excluded.length, 0);
});
test("durable source progress stops after its first infrastructure failure and closes incomplete", async () => {
  const { normalizeBeatportTrack } = require("../src/beatportClient"), collector = require("../src/sonicCatalogVerifiedCollector");
  const { createHash } = require("node:crypto"), hash = value => createHash("sha256").update(value).digest("hex");
  const f = fixture(async () => response(503)), request = { version: 1, recipe: { ...collector.VERIFIED_COLLECTOR_RECIPE },
    requests: structuredClone(collector.VERIFIED_COLLECTOR_REQUESTS), excludedBeatportTrackIds: [], excluded: [], excludedSourceSha256: [],
    heldOut: Array.from({ length: 6 }, (_, i) => ({ identityKey: "tidal:" + (i + 1), artist: "Heldout " + i, title: "Heldout " + i })) };
  let last = null, pages = 0, previews = 0;
  await assert.rejects(collector.collectSonicCatalogVerifiedPool({ request, requestSha256: hash(JSON.stringify(request)), now: () => "2026-10-08T00:00:00.000Z",
    beatport: { pagedTracks: async (pathname, options) => { pages++; const genreId = options.params.genre_id, id = String(Number(genreId) * 1000 + options.page);
      return { tracks: [normalizeBeatportTrack({ id, name: "Fixture " + id, mix_name: "Original Mix", artists: [{ id: id + "1", name: "Fixture Artist " + id }],
        genre: { id: genreId, name: genreId === "91" ? "Bass House" : "Techno (Raw / Deep / Hypnotic)" }, release: { id: id + "2", name: "Fixture Album " + id, publish_date: "2020-01-01" } })] }; },
      fetchPreviewBuffer: async () => { previews++; throw Error("unexpected preview"); } }, tidal: f.tidal,
    saveAudio: async () => { throw Error("unexpected audio"); }, probeDuration: async () => { throw Error("unexpected probe"); },
    persistProgress: async progress => { last = structuredClone(progress); runtime.stopIfInfrastructure(f.ledger); }
  }), error => error.code === "ECATALOGINFRASTRUCTURE");
  assert.equal(pages, 6); assert.equal(f.calls.length, 1); assert.equal(last.attempts.length, 1); assert.equal(previews, 0);
  const closed = runtime.closeInfrastructureCollection(last, f.ledger); assert.equal(closed.closed, true); assert.equal(closed.complete, false);
  assert.equal(closed.aborted, true); assert.equal(closed.infrastructureFailure.reason, "http-5xx"); assert.equal(last.closed, undefined);
});
