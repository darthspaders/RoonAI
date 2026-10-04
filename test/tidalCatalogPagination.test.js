"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TidalVerifier } = require("../src/tidalVerifier");
const { isCurrentSearchRequest, currentSearchDocument } = require("./tidalSearchFixture");

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[String(name || "").toLowerCase()] || null },
    json: async () => body
  };
}

function track(id) {
  return {
    id: String(id),
    type: "tracks",
    attributes: {
      title: `Catalog Track ${id}`,
      externalLinks: [{ href: `https://tidal.com/browse/track/${id}` }]
    },
    artists: [{ id: `artist-${id}`, name: `Catalog Artist ${id}` }],
    album: { id: `album-${id}`, title: `Catalog Album ${id}` },
    relationships: {
      artists: { data: [{ id: `artist-${id}`, type: "artists" }] },
      albums: { data: [{ id: `album-${id}`, type: "albums" }] }
    }
  };
}

function trackDocument(ids, next = null) {
  const included = ids.flatMap(id => [
    track(id),
    { id: `artist-${id}`, type: "artists", attributes: { name: `Catalog Artist ${id}` } },
    { id: `album-${id}`, type: "albums", attributes: { title: `Catalog Album ${id}`, releaseDate: "2026-01-01" } }
  ]);
  return {
    links: { next },
    data: ids.map(id => ({ id: String(id), type: "tracks" })),
    included
  };
}

function testFile(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-hole-tidal-pagination-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, `${name}.json`);
}

function tidal(file, fetchImpl) {
  return new TidalVerifier({
    enabled: true,
    accessToken: "catalog-token",
    countryCode: "US",
    catalogPaginationFile: file,
    fetchImpl,
    sleep: async () => {}
  });
}

test("searchTracks follows the first page and the cursor in links.next", async t => {
  const file = testFile(t, "cursor");
  const urls = [];
  const pages = [
    trackDocument(["1", "2"], "/v2/searchResults/anchor/relationships/tracks?countryCode=US&page%5Bcursor%5D=cursor-two"),
    trackDocument(["3", "4"])
  ];
  const events = [];
  const verifier = tidal(file, async url => {
    urls.push(new URL(url));
    return jsonResponse(pages[urls.length - 1]);
  });

  const first = await verifier.searchTracks("anchor", {
    limit: 2,
    detailLimit: 0,
    rotateCatalog: true,
    onPagination: event => events.push(event)
  });
  const second = await verifier.searchTracks("anchor", {
    limit: 2,
    detailLimit: 0,
    rotateCatalog: true,
    onPagination: event => events.push(event)
  });

  assert.deepEqual(first.map(item => item.id), ["1", "2"]);
  assert.deepEqual(second.map(item => item.id), ["3", "4"]);
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get("page[cursor]"), null);
  assert.equal(urls[1].searchParams.get("page[cursor]"), "cursor-two");
  assert.equal(events[0].requestedPage, 1);
  assert.equal(events[0].requestedCursor, null);
  assert.equal(events[0].nextCursor, "cursor-two");
  assert.equal(events[0].returnedCount, 2);
  assert.equal(events[0].acceptedCount, 2);
  assert.equal(events[0].budgetCost, 1);
  assert.equal(events[1].requestedCursor, "cursor-two");
  assert.equal(events[1].progressResumed, true);
  assert.equal(events[1].nextCursor, null);
});

test("searchTracks can crawl a bounded second page in one under-fill pass", async t => {
  const file = testFile(t, "bounded-pages");
  const urls = [];
  const events = [];
  const verifier = tidal(file, async url => {
    const parsed = new URL(url);
    urls.push(parsed);
    return jsonResponse(parsed.searchParams.get("page[cursor]")
      ? trackDocument(["3", "4"])
      : trackDocument(["1", "2"], "/v2/searchResults/bounded/relationships/tracks?countryCode=US&page%5Bcursor%5D=bounded-next"));
  });

  const results = await verifier.searchTracks("bounded", {
    limit: 2,
    detailLimit: 0,
    pageCount: 2,
    onPagination: event => events.push(event)
  });

  assert.deepEqual(results.map(item => item.id), ["1", "2", "3", "4"]);
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get("page[cursor]"), "bounded-next");
  assert.equal(events.length, 2);
  assert.equal(events[0].requestedPage, 1);
  assert.equal(events[1].progressResumed, true);
  assert.equal(events[1].nextCursor, null);
});

test("explicit page and offset metadata use fallback traversal only when returned", async t => {
  const pageFile = testFile(t, "page-fallback");
  const pageUrls = [];
  const pageVerifier = tidal(pageFile, async url => {
    const parsed = new URL(url);
    pageUrls.push(parsed);
    const page = parsed.searchParams.get("page") || "1";
    return jsonResponse({
      page: { current: Number(page), totalPages: 2 },
      items: [track(page)],
      nextPage: Number(page) < 2 ? 2 : null
    });
  });
  await pageVerifier.searchTracks("page-anchor", { limit: 1, detailLimit: 0, rotateCatalog: true });
  await pageVerifier.searchTracks("page-anchor", { limit: 1, detailLimit: 0, rotateCatalog: true });
  assert.equal(pageUrls[1].searchParams.get("page"), "2");

  const offsetFile = testFile(t, "offset-fallback");
  const offsetUrls = [];
  const offsetVerifier = tidal(offsetFile, async url => {
    const parsed = new URL(url);
    offsetUrls.push(parsed);
    const offset = Number(parsed.searchParams.get("offset") || 0);
    return jsonResponse({
      offset,
      limit: 1,
      total: 2,
      items: [track(offset + 10)]
    });
  });
  await offsetVerifier.searchTracks("offset-anchor", { limit: 1, detailLimit: 0, rotateCatalog: true });
  await offsetVerifier.searchTracks("offset-anchor", { limit: 1, detailLimit: 0, rotateCatalog: true });
  assert.equal(offsetUrls[1].searchParams.get("offset"), "1");
});

test("catalog progress resumes after a verifier restart and is isolated from page-one cache", async t => {
  const file = testFile(t, "restart");
  const calls = [];
  const fetchImpl = async url => {
    const parsed = new URL(url);
    calls.push(parsed);
    return jsonResponse(parsed.searchParams.get("page[cursor]")
      ? trackDocument(["next"])
      : trackDocument(["first"], "/v2/searchResults/restart/relationships/tracks?countryCode=US&page%5Bcursor%5D=restart-next"));
  };

  const firstVerifier = tidal(file, fetchImpl);
  await firstVerifier.searchTracks("restart", { limit: 1, detailLimit: 0, rotateCatalog: true });
  assert.match(fs.readFileSync(file, "utf8"), /restart-next/);

  const restartedVerifier = tidal(file, fetchImpl);
  const result = await restartedVerifier.searchTracks("restart", { limit: 1, detailLimit: 0, rotateCatalog: true });
  assert.deepEqual(result.map(item => item.id), ["next"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get("page[cursor]"), "restart-next");

  const cacheIsolationCalls = [];
  const isolatedVerifier = tidal(testFile(t, "cache-isolation"), async url => {
    cacheIsolationCalls.push(new URL(url));
    return jsonResponse(trackDocument(["isolated"], "/v2/searchResults/isolate/relationships/tracks?countryCode=US&page%5Bcursor%5D=isolate-next"));
  });
  await isolatedVerifier.searchTracks("isolate", { limit: 1, detailLimit: 0, rotateCatalog: false });
  await isolatedVerifier.searchTracks("isolate", { limit: 1, detailLimit: 0, rotateCatalog: true });
  assert.equal(cacheIsolationCalls.length, 2);
});

test("searchTracks suppresses rows repeated by a later cursor page", async t => {
  const file = testFile(t, "duplicates");
  const events = [];
  const verifier = tidal(file, async url => {
    const cursor = new URL(url).searchParams.get("page[cursor]");
    return jsonResponse(cursor
      ? trackDocument(["2", "3"])
      : trackDocument(["1", "2"], "/v2/searchResults/duplicates/relationships/tracks?countryCode=US&page%5Bcursor%5D=duplicate-next"));
  });

  await verifier.searchTracks("duplicates", { limit: 2, detailLimit: 0, rotateCatalog: true, onPagination: event => events.push(event) });
  const second = await verifier.searchTracks("duplicates", { limit: 2, detailLimit: 0, rotateCatalog: true, onPagination: event => events.push(event) });

  assert.deepEqual(second.map(item => item.id), ["3"]);
  assert.equal(events[1].returnedCount, 2);
  assert.equal(events[1].duplicateCount, 1);
});

test("an invalid or expired cursor resets once to the first page without changing auth or rate-limit handling", async t => {
  const file = testFile(t, "expired-cursor");
  const urls = [];
  const events = [];
  const verifier = tidal(file, async url => {
    const parsed = new URL(url);
    urls.push(parsed);
    if (urls.length === 1) return jsonResponse(trackDocument(["before"], "/v2/searchResults/expired/relationships/tracks?countryCode=US&page%5Bcursor%5D=expired"));
    if (parsed.searchParams.get("page[cursor]")) return jsonResponse({ error: "expired cursor" }, 400);
    return jsonResponse(trackDocument(["after"]));
  });

  await verifier.searchTracks("expired", { limit: 1, detailLimit: 0, rotateCatalog: true });
  const result = await verifier.searchTracks("expired", { limit: 1, detailLimit: 0, rotateCatalog: true, onPagination: event => events.push(event) });
  assert.deepEqual(result.map(item => item.id), ["after"]);
  assert.equal(urls.length, 3);
  assert.equal(urls[1].searchParams.get("page[cursor]"), "expired");
  assert.equal(urls[2].searchParams.get("page[cursor]"), null);
  assert.equal(events[0].cursorRecovery, true);
  assert.equal(events[0].progressResumed, true);

  const rateFile = testFile(t, "rate-limit");
  let rateCalls = 0;
  const rateVerifier = tidal(rateFile, async url => {
    rateCalls += 1;
    if (rateCalls === 1) return jsonResponse(trackDocument(["rate-first"], "/v2/searchResults/rate/relationships/tracks?countryCode=US&page%5Bcursor%5D=rate-next"));
    if (rateCalls <= 4) return jsonResponse({ error: "slow down" }, 429, { "retry-after": "0" });
    return jsonResponse(trackDocument(["rate-next"]));
  });
  await rateVerifier.searchTracks("rate", { limit: 1, detailLimit: 0, rotateCatalog: true });
  await assert.rejects(() => rateVerifier.searchTracks("rate", { limit: 1, detailLimit: 0, rotateCatalog: true }), /rate limited/);
  assert.equal(rateCalls, 4);

  const authFile = testFile(t, "auth");
  const authVerifier = tidal(authFile, async () => jsonResponse({ error: "unauthorized" }, 401));
  await assert.rejects(() => authVerifier.searchTracks("auth", { limit: 1, detailLimit: 0, rotateCatalog: true }), /catalog token was rejected|TIDAL_ACCESS_TOKEN was rejected/i);
});

test("an interrupted catalog page reports bounded budget cost without advancing progress", async t => {
  const file = testFile(t, "budget");
  const events = [];
  const error = new Error("catalog budget exhausted");
  error.code = "CATALOG_BUDGET_EXHAUSTED";
  const verifier = tidal(file, async () => {
    throw error;
  });

  await assert.rejects(() => verifier.searchTracks("budget", {
    rotateCatalog: true,
    onPagination: info => events.push(info)
  }), /catalog budget exhausted/);

  assert.equal(events.length, 1);
  assert.equal(events[0].source, "searchTracks");
  assert.equal(events[0].requestedPage, 1);
  assert.equal(events[0].returnedCount, 0);
  assert.equal(events[0].acceptedCount, 0);
  assert.equal(events[0].rejectedCount, 0);
  assert.equal(events[0].budgetCost, 1);
  assert.equal(events[0].progressResumed, false);
  assert.equal(fs.existsSync(file), false, "a failed first page must not create resumable progress");
});

test("artist and album collection anchors rotate independently", async t => {
  const file = testFile(t, "anchors");
  const albumCalls = [];
  const trackCalls = [];
  const verifier = tidal(file, async url => {
    const parsed = new URL(url);
    if (isCurrentSearchRequest(parsed) && parsed.searchParams.get("include") === "artists") {
      return jsonResponse(currentSearchDocument({ data: [{ id: "artist-anchor", type: "artists" }], included: [{ id: "artist-anchor", type: "artists", attributes: { name: "Anchor Artist" } }] }, "artists", "Anchor Artist"));
    }
    if (parsed.pathname.endsWith("/relationships/albums")) {
      albumCalls.push(parsed);
      const cursor = parsed.searchParams.get("page[cursor]");
      const id = cursor ? "album-two" : "album-one";
      return jsonResponse({
        links: { next: cursor ? null : "/v2/artists/artist-anchor/relationships/albums?countryCode=US&page%5Bcursor%5D=album-next" },
        data: [{ id, type: "albums" }],
        included: [{ id, type: "albums", attributes: { title: id === "album-one" ? "Album One" : "Album Two", releaseDate: "2026-01-01" } }]
      });
    }
    if (parsed.pathname === "/v2/albums") {
      trackCalls.push(parsed);
      return jsonResponse({
        data: [{ id: "album-anchor", type: "albums", relationships: { items: { data: [{ id: "track-one", type: "tracks" }], links: { next: "/albums/album-anchor/relationships/items?countryCode=US&page%5Bcursor%5D=track-next" } } } }],
        included: [track("track-one"), { id: "artist-track-one", type: "artists", attributes: { name: "Track Artist" } }, { id: "album-anchor", type: "albums", attributes: { title: "Album Anchor" } }]
      });
    }
    trackCalls.push(parsed);
    return jsonResponse({ data: [{ id: "track-two", type: "tracks" }], included: [track("track-two"), { id: "artist-track-two", type: "artists", attributes: { name: "Track Artist Two" } }, { id: "album-anchor", type: "albums", attributes: { title: "Album Anchor" } }] });
  });

  const firstAlbums = await verifier.getArtistAlbums("Anchor Artist", { limit: 1, rotateCatalog: true });
  const secondAlbums = await verifier.getArtistAlbums("Anchor Artist", { limit: 1, rotateCatalog: true });
  assert.deepEqual(firstAlbums.map(item => item.id), ["album-one"]);
  assert.deepEqual(secondAlbums.map(item => item.id), ["album-two"]);
  assert.equal(albumCalls[1].searchParams.get("page[cursor]"), "album-next");

  const firstTracks = await verifier.getAlbumTracks({ id: "album-anchor", title: "Album Anchor", artist: "Track Artist" }, { limit: 1, rotateCatalog: true });
  const secondTracks = await verifier.getAlbumTracks({ id: "album-anchor", title: "Album Anchor", artist: "Track Artist" }, { limit: 1, rotateCatalog: true });
  assert.deepEqual(firstTracks.map(item => item.id), ["track-one"]);
  assert.deepEqual(secondTracks.map(item => item.id), ["track-two"]);
  assert.equal(trackCalls[1].pathname, "/v2/albums/album-anchor/relationships/items");
  assert.equal(trackCalls[1].searchParams.get("page[cursor]"), "track-next");
});
