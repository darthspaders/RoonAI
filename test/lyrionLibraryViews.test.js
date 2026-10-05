"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { LyrionClient } = require("../src/lyrionClient");
const { createLyrionApi } = require("../src/lyrionApi");

// Shapes below are trimmed from a live LMS 9.1.1 `browselibrary items ... menu:1` response.
const libraryBase = { actions: {
  go: { cmd: ["browselibrary", "items"], params: { mode: "tracks", menu: 1 }, itemsParams: "commonParams", player: 0 },
  play: { cmd: ["playlistcontrol"], params: { cmd: "load", menu: 1 }, itemsParams: "commonParams", player: 0, nextWindow: "nowPlaying" },
  add: { cmd: ["playlistcontrol"], params: { cmd: "add", menu: 1 }, itemsParams: "commonParams", player: 0 },
  "add-hold": { cmd: ["playlistcontrol"], params: { cmd: "insert", menu: 1 }, itemsParams: "commonParams", player: 0 }
} };
const albumsResult = { count: 1, base: libraryBase, item_loop: [{
  text: "The Cure (2004)\nThe Cure", type: "playlist", "icon-id": "8db7ee67", icon: "music/8db7ee67/cover",
  commonParams: { album_id: "13046", performance: "" },
  presetParams: { favorites_title: "The Cure (2004)", favorites_url: "db:album.title=The%20Cure%20(2004)&contributor.name=The%20Cure", favorites_type: "playlist", icon: "music/8db7ee67/cover" }
}] };
const artistsResult = { count: 1, base: { actions: { ...libraryBase.actions, go: { ...libraryBase.actions.go, params: { mode: "albums", menu: 1 } } } }, item_loop: [{
  text: "The Cure", type: "playlist", icon: "contributor/2856a47d/image", commonParams: { artist_id: "23122" },
  presetParams: { favorites_title: "The Cure", favorites_url: "db:contributor.name=The%20Cure", favorites_type: "playlist", icon: "contributor/2856a47d/image" }
}] };

function recordingClient(responses) {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  client.calls = [];
  client.rpc = async (player, command) => {
    client.calls.push([player, command]);
    if (command[0] === "apps" || command[0] === "radios") return { item_loop: [] };
    const mode = command.find(part => /^mode:/.test(part));
    return responses[mode] || { count: 0, item_loop: [] };
  };
  return client;
}

test("the local library is offered as songs, albums and artists sources", async () => {
  const sources = await recordingClient({}).sources("p1");
  assert.deepEqual(sources.slice(0, 3).map(s => [s.id, s.title]), [
    ["local", "Local Library / NAS"], ["local-albums", "Local Library: Albums"], ["local-artists", "Local Library: Artists"]]);
});

test("album search uses the LMS library browser and each album opens its tracks or plays as a whole", async () => {
  const client = recordingClient({ "mode:albums": albumsResult });
  const result = await client.browse("p1", { source: "local-albums", query: "cure", offset: 0, limit: 50 });
  assert.deepEqual(client.calls.at(-1), ["p1", ["browselibrary", "items", 0, 50, "mode:albums", "search:cure", "menu:1"]]);
  assert.equal(result.count, 1);
  const [album] = result.items;
  assert.equal(album.title, "The Cure (2004)\nThe Cure");
  assert.deepEqual(Object.keys(album.actions).sort(), ["add", "browse", "next", "play"]);

  await client.browse("p1", { token: album.actions.browse, query: "", offset: 0, limit: 50 });
  assert.deepEqual(client.calls.at(-1), ["p1", ["browselibrary", "items", 0, 50, "mode:tracks", "menu:1", "album_id:13046", "performance:"]]);
  await client.execute("p1", album.actions.play, "play");
  assert.deepEqual(client.calls.at(-1), ["p1", ["playlistcontrol", "cmd:load", "menu:1", "album_id:13046", "performance:"]]);
  await client.execute("p1", album.actions.next, "next");
  assert.deepEqual(client.calls.at(-1), ["p1", ["playlistcontrol", "cmd:insert", "menu:1", "album_id:13046", "performance:"]]);
});

test("browsing albums or artists without a search term lists the whole library section", async () => {
  const client = recordingClient({ "mode:artists": artistsResult });
  const result = await client.browse("p1", { source: "local-artists", offset: 50, limit: 25 });
  assert.deepEqual(client.calls.at(-1), ["p1", ["browselibrary", "items", 50, 25, "mode:artists", "menu:1"]]);
  const [artist] = result.items;
  await client.browse("p1", { token: artist.actions.browse, offset: 0, limit: 50 });
  assert.deepEqual(client.calls.at(-1), ["p1", ["browselibrary", "items", 0, 50, "mode:albums", "menu:1", "artist_id:23122"]]);
});

test("library album covers and artist pictures resolve to LMS image paths through the artwork proxy", async () => {
  const albums = await recordingClient({ "mode:albums": albumsResult }).browse("p1", { source: "local-albums", query: "cure" });
  assert.equal(new URL(albums.items[0].artwork, "http://rh.example").searchParams.get("path"), "/music/8db7ee67/cover.jpg");
  const artists = await recordingClient({ "mode:artists": artistsResult }).browse("p1", { source: "local-artists", query: "cure" });
  assert.equal(new URL(artists.items[0].artwork, "http://rh.example").searchParams.get("path"), "/contributor/2856a47d/image");
});

test("searching the albums or artists source returns library entries and a resumable request", async () => {
  const client = recordingClient({ "mode:albums": albumsResult, "mode:artists": artistsResult });
  const result = await client.search("p1", "cure", ["local-albums", "local-artists"]);
  assert.deepEqual(result.results.map(r => [r.source, r.searchable, r.items.length]), [["Local Library: Albums", true, 1], ["Local Library: Artists", true, 1]]);
  assert.deepEqual(result.results[0].request, { source: "local-albums", query: "cure" });
});

test("the artwork proxy accepts LMS artist pictures but still refuses other paths", async () => {
  const fetched = [];
  const realFetch = global.fetch;
  global.fetch = async url => { fetched.push(String(url)); return { ok: true, headers: { get: () => "image/jpeg" }, body: (async function* () { yield Buffer.from("img"); })() }; };
  try {
    const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
    const sent = [];
    const api = createLyrionApi({ roon: { getState: () => ({ zones: [] }) }, client, file: "does-not-exist", readJson: async () => ({}),
      sendJson: (res, status, body) => sent.push([status, body]) });
    const res = { writeHead(status) { this.status = status; }, end() {} };
    await api.handle({ method: "GET" }, res, new URL("http://rh.example/api/lyrion/artwork?path=%2Fcontributor%2F2856a47d%2Fimage"));
    assert.equal(res.status, 200);
    assert.deepEqual(fetched, ["http://lms.example:9000/contributor/2856a47d/image"]);
    await api.handle({ method: "GET" }, res, new URL("http://rh.example/api/lyrion/artwork?path=%2Fsettings%2Fserver"));
    assert.deepEqual(sent.at(-1), [400, { error: "Invalid artwork path" }]);
    assert.equal(fetched.length, 1);
  } finally { global.fetch = realFetch; }
});

test("choosing a local library source in the UI browses it by source id rather than an action token", async () => {
  const source = fs.readFileSync(require.resolve("../public/lyrion.js"), "utf8");
  const homeCode = source.slice(source.indexOf("  async function home()"), source.indexOf("  async function search(all)"));
  const requests = [];
  const context = { sources: [{ id: "local" }, { id: "local-albums" }, { id: "spotty", actions: { browse: "tok" } }],
    $: id => ({ lyrionSource: { value: context.selected }, lyrionQuery: { value: "cure" } })[id],
    browse: async request => requests.push(request), history: [], selected: "" };
  vm.runInNewContext(`${homeCode}; this.home = home;`, context);
  for (const selected of ["local", "local-albums", "spotty"]) { context.selected = selected; await context.home(); }
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ source: "local" }, { source: "local-albums" }, { token: "tok", query: "cure" }]);
});

test("assistant tools can browse the album and artist library views", async () => {
  const { createParallelMusicTools } = require("../src/parallelMusicTools");
  const calls = [];
  const tools = createParallelMusicTools(async (route, options) => { calls.push({ route, ...options }); return { ok: true }; });
  for (const source of ["local", "local-albums", "local-artists"]) await tools.lyrion_browse.handler({ playerId: "p", source, query: "cure" });
  assert.deepEqual(calls.map(c => [c.route, c.body.source]), [["/api/lyrion/browse", "local"], ["/api/lyrion/browse", "local-albums"], ["/api/lyrion/browse", "local-artists"]]);
  assert.throws(() => tools.lyrion_browse.handler({ playerId: "p", source: "local-everything" }), /Invalid/);
});

test("an LMS app whose command is also a built-in library id gets its own source id", async () => {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  client.rpc = async (player, command) => command[0] === "radios"
    ? { item_loop: [{ text: "Local Radio", actions: { go: { cmd: ["local", "items"], params: { menu: "local" } } } }] }
    : { item_loop: [] };
  const sources = await client.sources("p1");
  const ids = sources.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  const radio = sources.find(s => s.title === "Local Radio");
  assert.notEqual(radio.id, "local");
  assert.ok(radio.actions.browse);
  assert.equal(sources.find(s => s.id === "local").title, "Local Library / NAS");
});
