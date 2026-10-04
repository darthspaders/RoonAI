"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TidalVerifier } = require("../src/tidalVerifier");
const { discoverTracks, buildDiscoveryProfile, buildSearchQueries, rejectReason } = require("../src/discoveryEngine");
const { isCurrentSearchRequest, currentSearchDocument } = require("./tidalSearchFixture");

function catalogDocument(rows, next = null) {
  return {
    links: { next },
    data: rows.map(row => ({ type: "tracks", id: String(row.id) })),
    included: rows.flatMap(row => [
      { type: "tracks", id: String(row.id), attributes: {
        title: row.title || `Signal ${row.id}`, version: row.version || "",
        duration: row.duration || "PT8M", isrc: "GBABC2600001",
        externalLinks: [{ href: `https://tidal.com/track/${row.id}` }]
      }, relationships: {
        artists: { data: [{ type: "artists", id: `artist-${row.id}` }] },
        albums: { data: [{ type: "albums", id: `album-${row.id}` }] }
      } },
      { type: "artists", id: `artist-${row.id}`, attributes: { name: row.artist || "Solarstone" } },
      { type: "albums", id: `album-${row.id}`, attributes: {
        title: row.album || row.title || `Signal ${row.id}`, releaseDate: "2026-01-01", copyright: "Pure Trance"
      } }
    ])
  };
}

function client(t, respond, file) {
  if (!file) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-hole-catalog-retrieval-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    file = path.join(directory, "progress.json");
  }
  return new TidalVerifier({
    enabled: true, accessToken: "test-token", catalogPaginationFile: file, sleep: async () => {},
    fetchImpl: async url => {
      const parsed = new URL(url);
      let doc = respond(parsed);
      if (isCurrentSearchRequest(parsed)) {
        if (String(doc.links?.next || "").startsWith("?")) doc = { ...doc, links: { next: `/v2/searchResults/opaque-result/relationships/tracks${doc.links.next}` } };
        doc = currentSearchDocument(doc, "tracks", parsed.searchParams.get("filter[query]"));
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => doc };
    }
  });
}

const tranceOptions = {
  genres: "progressive trance", count: 3, minDurationMinutes: 7,
  request: "Find progressive trance tracks at least 7 minutes", scoringMode: "pure"
};

test("ordinary discovery requests nested metadata and retains distinct named versions without detail calls", async t => {
  const calls = [];
  const tidal = client(t, url => {
    calls.push(url);
    assert.equal(url.searchParams.get("include"), "tracks,tracks.artists,tracks.albums");
    return catalogDocument([
      { id: 1, title: "Seven Cities", version: "Original Atlantis Mix" },
      { id: 2, title: "Seven Cities", version: "Pure Mix" },
      { id: 3, title: "Seven Cities (Pure Mix)", version: "Pure Mix" }
    ]);
  });
  const rows = await tidal.searchTracks("Solarstone", { detailLimit: 0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(rows.map(row => row.title), [
    "Seven Cities (Original Atlantis Mix)", "Seven Cities (Pure Mix)", "Seven Cities (Pure Mix)"
  ]);
});

test("rotating search consumes all provider rows before advancing, including across restart", async t => {
  const calls = [];
  const respond = url => {
    calls.push(url);
    return url.searchParams.has("page[cursor]")
      ? catalogDocument([{ id: 21 }])
      : catalogDocument(Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })), "?page[cursor]=second");
  };
  const tidal = client(t, respond);
  const events = [];
  const first = await tidal.searchTracks("Solarstone", { limit: 6, detailLimit: 0, rotateCatalog: true, onPagination: info => events.push(info) });
  const restarted = client(t, respond, tidal.catalogProgress.file);
  const second = await restarted.searchTracks("Solarstone", { limit: 6, detailLimit: 0, rotateCatalog: true });
  assert.deepEqual([...first, ...second].map(row => row.id), Array.from({ length: 21 }, (_, i) => String(i + 1)));
  assert.equal(events[0].acceptedCount, 20);
  assert.equal(events[0].rejectedCount, 0);
  assert.equal(calls[1].searchParams.get("page[cursor]"), "second");
  assert.equal(calls[1].searchParams.get("include"), "tracks,tracks.artists,tracks.albums");
  assert.equal(calls[1].searchParams.get("countryCode"), "US");
});

test("full-page discovery and bounded lookups have separate caches", async t => {
  const tidal = client(t, () => catalogDocument(Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }))));
  const bounded = await tidal.searchTracks("Solarstone", { limit: 6, detailLimit: 0 });
  const full = await tidal.searchTracks("Solarstone", { limit: 6, detailLimit: 0, fullPage: true });
  assert.equal(bounded.length, 6);
  assert.equal(full.length, 20);
});

test("one sparse row does not force detail requests for all complete rows", async t => {
  const detailCalls = [];
  const tidal = client(t, url => {
    const doc = catalogDocument([{ id: 1 }, { id: 2 }, { id: 3 }]);
    if (isCurrentSearchRequest(url)) {
      doc.included = doc.included.filter(item => item.id !== "artist-2");
      return doc;
    }
    detailCalls.push(url.pathname);
    const detail = catalogDocument([{ id: 2 }]);
    detail.data = detail.included.find(item => item.type === "tracks");
    return detail;
  });
  const rows = await tidal.searchTracks("Solarstone", { detailLimit: 0, fullPage: true });
  assert.equal(rows.length, 3);
  assert.deepEqual(detailCalls, ["/v2/tracks/2"]);
});

test("album pagination consumes a whole page and preserves version names", async t => {
  const tidal = client(t, () => {
    const doc = catalogDocument(Array.from({ length: 20 }, (_, i) => ({ id: i + 1, version: "Extended Mix" })));
    doc.data = [{ type: "albums", id: "release", relationships: { items: { data: doc.data } } }];
    return doc;
  });
  const rows = await tidal.getAlbumTracks({ id: "release", artist: "Solarstone", title: "Release" }, { limit: 3, rotateCatalog: true });
  assert.equal(rows.length, 20);
  assert.equal(rows[19].title, "Signal 20 (Extended Mix)");
});

test("real catalog mapping feeds valid results below rank six through discovery admission", async t => {
  const tidal = client(t, url => {
    const query = url.searchParams.get("filter[query]") || "Solarstone";
    return query === "Solarstone" ? catalogDocument([
      ...Array.from({ length: 6 }, (_, i) => ({ id: i + 1, duration: "PT3M" })),
      { id: 7, title: "Solarcoaster", version: "Original Mix" },
      { id: 8, title: "Hey Jude", artist: "The Beatles", album: "Hey Jude" }
    ]) : catalogDocument([]);
  });
  tidal.getArtistAlbums = async () => [];
  const result = await discoverTracks({ tidal, options: { ...tranceOptions, count: 1 } });
  assert.ok(result.tracks.some(track => track.tidal?.id === "7"));
  assert.equal(result.tracks.some(track => track.artist === "The Beatles"), false);
  assert.ok(result.tracks.every(track => track.tidal.durationMs >= 420000));
});

test("deep discovery continues after the first page instead of spending recovery on page one again", async t => {
  const cursors = [];
  const tidal = client(t, url => {
    const query = url.searchParams.get("filter[query]") || "Solarstone";
    if (query !== "Solarstone") return catalogDocument([]);
    const cursor = url.searchParams.get("page[cursor]");
    cursors.push(cursor);
    return cursor ? catalogDocument([{ id: 2, title: "Solarcoaster" }])
      : catalogDocument([{ id: 1, title: "Seven Cities" }], "?page[cursor]=second");
  });
  tidal.getArtistAlbums = async () => [];
  const result = await discoverTracks({ tidal, options: tranceOptions });
  assert.deepEqual(cursors, [null, "second"]);
  assert.ok(result.tracks.some(track => track.tidal?.id === "2"));
});

test("numbered hour-long DJ sets fail catalogue admission without rejecting long standalone mixes", () => {
  const profile = buildDiscoveryProfile(tranceOptions);
  const track = { artist: "Giuseppe Ottaviani", title: "Solarstone presents Pure Trance 2 Mix 2", album: "Pure Trance 2", durationMs: 4627000, query: "Giuseppe Ottaviani progressive trance" };
  assert.match(rejectReason(track, tranceOptions, profile), /Compilation/);
  assert.match(rejectReason({ ...track, artist: "Forerunners", title: "Communicator (Mixed)", album: "Pure Trance", durationMs: 431000, query: "Forerunners" }, tranceOptions, profile), /Compilation/);
  assert.equal(rejectReason({ ...track, artist: "Solarstone", title: "Seven Cities (Original Atlantis Mix)", album: "Seven Cities", durationMs: 535000, query: "Solarstone" }, tranceOptions, profile), "");
});

test("trusted scene names must match artist credits, not a substring of a different artist", () => {
  const options = { ...tranceOptions, scoringMode: "taste-guided" };
  const profile = buildDiscoveryProfile(options);
  const track = { artist: "Paul Thomas Saunders", title: "Santa Muerte's Lightning & Flare", album: "Beautiful Desolation", label: "Warner Music UK Limited", durationMs: 466000, query: "Paul Thomas" };
  assert.notEqual(rejectReason(track, options, profile), "");
  assert.equal(rejectReason({ ...track, artist: "Paul Thomas, Christian Burns", title: "Enjoy the Silence (Extended Mix)", album: "Enjoy the Silence", label: "Black Hole Recordings" }, options, profile), "");
});

test("the crawl keeps searching when its raw pool cannot fill the requested artist diversity", async () => {
  const queries = [];
  const options = { ...tranceOptions, count: 3, request: "Find 3 progressive trance tracks, one per artist, at least 7 minutes" };
  const tracksFor = (artist, count) => Array.from({ length: count }, (_, i) => ({
    id: `${artist}-${i}`, artist, title: `Signal ${i}`, album: `${artist} Release ${i}`, durationMs: 480000,
    tidalUrl: `https://tidal.com/track/${artist === "Solarstone" ? 100 + i : artist === "Paul Thomas" ? 200 + i : 300 + i}`
  }));
  const result = await discoverTracks({ options, tidal: {
    isConfigured: () => true,
    searchTracks: async query => {
      queries.push(query);
      if (query === "Solarstone") return tracksFor("Solarstone", 20);
      if (query === "Paul Thomas") return tracksFor("Paul Thomas", 1);
      if (query === "Jerome Isma-Ae") return tracksFor("Jerome Isma-Ae", 1);
      return [];
    }
  } });
  assert.equal(result.tracks.length, 3, JSON.stringify({ queries, rejected: result.discarded.map(track => ({ artist: track.artist, reason: track.reason })) }));
  assert.equal(new Set(result.tracks.map(track => track.artist)).size, 3);
  assert.ok(queries.includes("Paul Thomas"));
  assert.ok(queries.includes("Jerome Isma-Ae"));
});

test("reserving the literal genre query does not lose the displaced Forerunners anchor", async () => {
  const queries = [];
  await discoverTracks({ options: { ...tranceOptions, count: 10 }, tidal: {
    isConfigured: () => true,
    searchTracks: async query => { queries.push(query); return []; }
  } });
  assert.ok(queries.includes("Forerunners"), JSON.stringify(queries));
});

test("progressive trance plans use direct existing scene artists to fill artist diversity", () => {
  const options = { ...tranceOptions, count: 10 };
  const queries = buildSearchQueries(options, null, buildDiscoveryProfile(options));
  for (const artist of ["Forerunners", "John 00 Fleming", "Airwave", "The Thrillseekers"]) {
    assert.ok(queries.includes(artist), `${artist} has no direct catalog query`);
  }
  assert.ok(queries.includes("progressive trance"));
  assert.ok(queries.some(query => /JOOF/.test(query)));
});
