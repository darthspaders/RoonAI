"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSearchUrl, searchRelationForUrl, toLegacySearchShape } = require("../src/tidalSearchCompat");
const { TidalVerifier } = require("../src/tidalVerifier");
const { RadioMetadataResolver } = require("../src/radioMetadataResolver");
const { chooseExact } = require("../src/exactTrackVerification");
const { currentSearchDocument } = require("./tidalSearchFixture");

function response(body) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

function track(id, title = `Signal ${id}`, version = "") {
  return { type: "tracks", id, attributes: { title, version, duration: "PT7M", externalLinks: [{ href: `https://tidal.com/track/${id}` }] }, relationships: { artists: { data: [{ type: "artists", id: "artist" }] }, albums: { data: [{ type: "albums", id: "album" }] } } };
}

function document(ids, next = null) {
  return { data: ids.map(id => ({ type: "tracks", id })), links: { next }, included: [...ids.map(id => track(id)), { type: "artists", id: "artist", attributes: { name: "Signal Artist" } }, { type: "albums", id: "album", attributes: { title: "Signal Album" } }] };
}

test("initial searches use filter text without double-decoding punctuation or Unicode", () => {
  const query = "AC/DC? 100% & café 🎵 (Club Mix)";
  const url = createSearchUrl(query, "tracks", { countryCode: "GB", explicitFilter: "EXCLUDE", include: "tracks.artists,tracks.albums,tracks.artists", limit: 6 });
  assert.equal(url.pathname, "/v2/searchResults");
  assert.equal(url.searchParams.get("filter[query]"), query);
  assert.equal(url.searchParams.get("countryCode"), "GB");
  assert.equal(url.searchParams.get("explicitFilter"), "EXCLUDE");
  assert.equal(url.searchParams.get("include"), "tracks,tracks.artists,tracks.albums");
  assert.equal(url.searchParams.has("limit"), false);
});

test("artist search requests its own linkage and rejects unknown relations", () => {
  const url = createSearchUrl("deadmau5", "artists", { countryCode: "US" });
  assert.equal(url.searchParams.get("include"), "artists");
  assert.equal(searchRelationForUrl(url), "artists");
  assert.throws(() => createSearchUrl("q", "unsupported"), /relationship/);
});

test("returned opaque relationship IDs and non-search resources are never interpreted as queries", () => {
  for (const url of ["https://openapi.tidal.com/v2/searchResults/opaque-id/relationships/tracks?page%5Bcursor%5D=next", "https://openapi.tidal.com/v2/tracks/42?include=artists", "https://other.example/v2/searchResults?filter%5Bquery%5D=q&include=tracks", "not a URL"]) assert.equal(searchRelationForUrl(url), "");
});

test("normalization retains hit relevance, related metadata and relationship pagination without mutation", () => {
  const input = currentSearchDocument(document(["2", "1"], "/searchResults/opaque-id/relationships/tracks?page%5Bcursor%5D=cursor-two"));
  input.meta = { collection: true };
  input.data[0].relationships.tracks.meta = { total: 50 };
  const before = JSON.stringify(input);
  const output = toLegacySearchShape(input, "tracks");
  assert.deepEqual(output.data.map(item => item.id), ["2", "1"]);
  assert.deepEqual(output.items.map(item => item.id), ["2", "1"]);
  assert.equal(output.included, input.included);
  assert.equal(output.links.next, input.data[0].relationships.tracks.links.next);
  assert.deepEqual(output.meta, { collection: true, total: 50 });
  assert.equal(JSON.stringify(input), before);
});

test("missing track linkage stays empty even when unrelated included tracks exist", () => {
  const input = { data: [{ id: "opaque", type: "searchResults", relationships: {} }], included: [track("unrelated")] };
  const output = toLegacySearchShape(input, "tracks");
  assert.deepEqual(output.data, []);
  assert.deepEqual(output.items, []);
  assert.equal(output.included, input.included);
});

test("already flat relationship pages, ordinary resources and null pass through unchanged", () => {
  const flat = document(["1"]);
  const resource = { data: { type: "tracks", id: "1" } };
  assert.equal(toLegacySearchShape(flat, "tracks"), flat);
  assert.equal(toLegacySearchShape(resource, "tracks"), resource);
  assert.equal(toLegacySearchShape(null, "tracks"), null);
  assert.equal(toLegacySearchShape(flat, ""), flat);
});

test("older object-shaped search resources preserve artist linkage", () => {
  const input = { data: { id: "q", type: "searchResults", relationships: { artists: { data: [{ id: "artist", type: "artists" }] } } }, included: [] };
  assert.deepEqual(toLegacySearchShape(input, "artists").data, [{ id: "artist", type: "artists" }]);
});

test("current search collection follows its opaque cursor link with nested includes and exact country", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-hole-current-search-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const verifier = new TidalVerifier({ enabled: true, accessToken: "test-token", countryCode: "GB", sleep: async () => {}, catalogPaginationFile: path.join(directory, "progress.json"), fetchImpl: async input => {
    const url = new URL(input); calls.push(url);
    if (calls.length === 1) {
      assert.equal(url.pathname, "/v2/searchResults");
      assert.equal(url.searchParams.get("filter[query]"), "Original Query");
      assert.equal(url.searchParams.has("limit"), false);
      return response(currentSearchDocument(document(["first"], "/searchResults/opaque-not-the-query/relationships/tracks?page%5Bcursor%5D=next")));
    }
    assert.equal(url.pathname, "/v2/searchResults/opaque-not-the-query/relationships/tracks");
    assert.equal(url.searchParams.get("page[cursor]"), "next");
    assert.equal(url.searchParams.has("filter[query]"), false);
    assert.equal(url.searchParams.get("countryCode"), "GB");
    assert.equal(url.searchParams.get("include"), "tracks,tracks.artists,tracks.albums");
    return response(document(["second"]));
  } });
  const results = await verifier.searchTracks("Original Query", { pageCount: 2, detailLimit: 0 });
  assert.deepEqual(results.map(item => item.id), ["first", "second"]);
  assert.equal(calls.length, 2);
});

test("direct exact candidate retrieval uses the collection contract and retains named remix identity", async () => {
  let calls = 0;
  const verifier = new TidalVerifier({ enabled: true, accessToken: "test-token", countryCode: "US", fetchImpl: async input => {
    calls += 1; const url = new URL(input);
    assert.equal(url.pathname, "/v2/searchResults");
    assert.equal(url.searchParams.get("filter[query]"), "Signal Artist Signal (Club Mix)");
    assert.equal(url.searchParams.get("include"), "tracks,tracks.artists,tracks.albums");
    const doc = document(["right", "wrong"]);
    doc.included[0] = track("right", "Signal", "Club Mix");
    doc.included[1] = track("wrong", "Signal", "Radio Edit");
    return response(currentSearchDocument(doc));
  } });
  const candidates = await verifier.searchExactCandidates({ artist: "Signal Artist", title: "Signal (Club Mix)" });
  assert.equal(calls, 1);
  assert.equal(candidates.find(item => item.id === "right")?.title, "Signal (Club Mix)");
  assert.equal(candidates.find(item => item.id === "wrong")?.title, "Signal (Radio Edit)");
  assert.equal(chooseExact({ artist: "Signal Artist", title: "Signal (Club Mix)" }, candidates).match.id, "right");
});

test("direct exact ID retrieval keeps its track resource endpoint", async () => {
  const doc = document(["42"]); doc.data = doc.included[0];
  const verifier = new TidalVerifier({ enabled: true, accessToken: "test-token", fetchImpl: async input => {
    const url = new URL(input); assert.equal(url.pathname, "/v2/tracks/42"); assert.equal(url.searchParams.has("filter[query]"), false); return response(doc);
  } });
  const candidates = await verifier.searchExactCandidates({ artist: "Signal Artist", title: "Signal 42" }, { id: "42" });
  assert.equal(candidates[0].id, "42");
});

test("radio artwork fetch normalizes current search data and preserves track-specific metadata includes", async () => {
  const resolver = new RadioMetadataResolver({ tidalAccessToken: "test-token", fetchImpl: async input => {
    const url = new URL(input); assert.equal(url.pathname, "/v2/searchResults"); assert.equal(url.searchParams.get("countryCode"), "GB"); assert.equal(url.searchParams.get("include"), "tracks,tracks.albums,tracks.artists"); return response(currentSearchDocument(document(["radio"])));
  } });
  const url = createSearchUrl("Signal Artist", "tracks", { countryCode: "GB", include: "tracks.albums,tracks.artists" });
  const result = await resolver.fetchTidalSearchJson(url.toString());
  assert.equal(result.data[0].id, "radio");
  assert.equal(result.items[0].relationships.artists.data[0].id, "artist");
});
