"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { LyrionClient } = require("../src/lyrionClient");
const { createLyrionApi } = require("../src/lyrionApi");
const { createParallelMusicTools } = require("../src/parallelMusicTools");

// Shapes below are trimmed from a live LMS 9.1.1 response.
const newAlbums = { count: 100, base: { actions: {
  go: { cmd: ["browselibrary", "items"], params: { mode: "tracks", menu: 1 }, itemsParams: "commonParams" },
  play: { cmd: ["playlistcontrol"], params: { cmd: "load", menu: 1 }, itemsParams: "commonParams" }
} }, item_loop: [{ text: "Say You Will\nFleetwood Mac", "icon-id": "678d5ce5", icon: "music/678d5ce5/cover", type: "playlist",
  commonParams: { album_id: "13903", performance: "" } }] };
const favorites = { count: 1, base: { actions: {
  go: { cmd: ["favorites", "playlist", "play"], params: { menu: "favorites" }, itemsParams: "params" },
  play: { cmd: ["favorites", "playlist", "play"], params: { menu: "favorites" }, itemsParams: "params" },
  add: { cmd: ["favorites", "playlist", "add"], params: { menu: "favorites" }, itemsParams: "params" }
} }, item_loop: [{ text: "SomaFM Drone Zone 256", goAction: "play", type: "audio", style: "itemplay",
  icon: "/imageproxy/http%3A%2F%2Fapi.somafm.com%2Flogos%2F256%2Fdronezone256.png/image.png",
  params: { item_id: "f070a142.0" },
  presetParams: { favorites_url: "http://api.somafm.com/dronezone256.pls", favorites_type: "audio", favorites_title: "SomaFM Drone Zone 256" } }] };
const apps = { item_loop: [{ text: "Radio Paradise", icon: "plugins/RadioParadise/html/icon.png",
  actions: { go: { cmd: ["radioparadise", "items"], params: { menu: "radioparadise" } } } }] };
const radios = { item_loop: [{ text: "SomaFM", "icon-id": "plugins/SomaFM/SomaFM_svg.png",
  actions: { go: { cmd: ["somafm", "items"], params: { menu: "somafm" } } } }] };

function recordingClient(overrides = {}) {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  client.calls = [];
  client.rpc = async (player, command) => {
    client.calls.push(command);
    const key = command[0] === "browselibrary" ? command.find(part => /^sort:/.test(part)) || "browse" : command[0];
    if (overrides[key] instanceof Error) throw overrides[key];
    return overrides[key] || { "sort:new": newAlbums, favorites, apps, radios }[key] || { count: 0, item_loop: [] };
  };
  return client;
}

test("new music and Lyrion favorites are offered as library sources after songs, albums and artists", async () => {
  const sources = await recordingClient().sources("p1");
  assert.deepEqual(sources.slice(0, 5).map(s => [s.id, s.title]), [
    ["local", "Local Library / NAS"], ["local-albums", "Local Library: Albums"], ["local-artists", "Local Library: Artists"],
    ["local-new", "Local Library: New Music"], ["favorites", "Lyrion Favorites"]]);
});

test("radio menu sources fall back to LMS's stock radio icon when their own icon fails, and apps do not", async () => {
  const sources = await recordingClient().sources("p1");
  const soma = sources.find(s => s.title === "SomaFM");
  assert.equal(new URL(soma.artwork, "http://rh.example").searchParams.get("path"), "/plugins/SomaFM/SomaFM_svg.png");
  assert.equal(new URL(soma.artworkFallback, "http://rh.example").searchParams.get("path"), "/html/images/radio.png");
  assert.equal(sources.find(s => s.title === "Radio Paradise").artworkFallback, undefined);
});

test("new music lists albums newest first and each album plays or opens its tracks", async () => {
  const client = recordingClient();
  const result = await client.browse("p1", { source: "local-new", offset: 0, limit: 25 });
  assert.deepEqual(client.calls.at(-1), ["browselibrary", "items", 0, 25, "mode:albums", "sort:new", "menu:1"]);
  assert.equal(result.count, 100);
  const [album] = result.items;
  assert.equal(album.title, "Say You Will\nFleetwood Mac");
  assert.equal(new URL(album.artwork, "http://rh.example").searchParams.get("path"), "/music/678d5ce5/cover.jpg");
  await client.execute("p1", album.actions.play, "play");
  assert.deepEqual(client.calls.at(-1), ["playlistcontrol", "cmd:load", "menu:1", "album_id:13903", "performance:"]);
});

test("Lyrion favorites browse the server's own favorites and play through its favorites command", async () => {
  const client = recordingClient();
  const result = await client.browse("p1", { source: "favorites", offset: 0, limit: 50 });
  assert.deepEqual(client.calls.at(-1), ["favorites", "items", 0, 50, "menu:1"]);
  const [station] = result.items;
  assert.equal(station.title, "SomaFM Drone Zone 256");
  assert.equal(station.url, "http://api.somafm.com/dronezone256.pls");
  assert.equal(station.actions.browse, undefined);
  assert.equal(new URL(station.artwork, "http://rh.example").searchParams.get("path"),
    "/imageproxy/http%3A%2F%2Fapi.somafm.com%2Flogos%2F256%2Fdronezone256.png/image.png");
  await client.execute("p1", station.actions.play, "play");
  assert.deepEqual(client.calls.at(-1), ["favorites", "playlist", "play", "menu:favorites", "item_id:f070a142.0"]);
});

test("search treats new music and favorites as browse-only and never queries them", async () => {
  const client = recordingClient();
  const result = await client.search("p1", "drone", ["local-new", "favorites"]);
  assert.deepEqual(result.results.map(r => [r.source, r.searchable, r.items.length]), [["Local Library: New Music", false, 0], ["Lyrion Favorites", false, 0]]);
  assert.equal(client.calls.some(c => c[0] === "favorites" || c.includes("sort:new")), false);
});

test("every source carries an LMS icon through the artwork proxy, the library ones using LMS's stock images", async () => {
  const sources = await recordingClient().sources("p1");
  const icon = id => new URL(sources.find(s => s.id === id).artwork, "http://rh.example").searchParams.get("path");
  assert.equal(icon("radioparadise"), "/plugins/RadioParadise/html/icon.png");
  assert.deepEqual(["local", "local-albums", "local-artists", "local-new", "favorites"].map(icon),
    ["/html/images/musicfolder.png", "/html/images/albums.png", "/html/images/artists.png", "/html/images/newmusic.png", "/html/images/favorites.png"]);
});

test("the home endpoint returns new music, favorites and explore sources, and one failing shelf does not hide the others", async () => {
  const sent = [];
  const call = async client => {
    const api = createLyrionApi({ roon: { getState: () => ({ zones: [] }) }, client, file: "does-not-exist", readJson: async () => ({}),
      sendJson: (res, status, body) => sent.push([status, body]) });
    await api.handle({ method: "GET" }, {}, new URL("http://rh.example/api/lyrion/home?playerId=p1"));
    return sent.at(-1);
  };
  const healthy = recordingClient();
  const [status, home] = await call(healthy);
  assert.equal(status, 200);
  assert.deepEqual(healthy.calls.find(c => c.includes("sort:new")), ["browselibrary", "items", 0, 25, "mode:albums", "sort:new", "menu:1"]);
  assert.deepEqual(home.newMusic.items.map(i => i.title), ["Say You Will\nFleetwood Mac"]);
  assert.equal(home.newMusic.count, 100);
  assert.deepEqual(home.favorites.items.map(i => i.title), ["SomaFM Drone Zone 256"]);
  assert.ok(home.explore.sources.some(s => s.title === "Radio Paradise"));
  assert.equal(home.explore.sources.some(s => s.id === "local-new" || s.id === "favorites"), false);

  const [, partial] = await call(recordingClient({ favorites: new Error("Lyrion: favorites unavailable") }));
  assert.equal(partial.favorites.error, "Lyrion: favorites unavailable");
  assert.deepEqual(partial.favorites.items, []);
  assert.deepEqual(partial.newMusic.items.map(i => i.title), ["Say You Will\nFleetwood Mac"]);
});

test("assistant tools can browse new music and Lyrion favorites", async () => {
  const calls = [];
  const tools = createParallelMusicTools(async (route, options) => { calls.push({ route, ...options }); return { ok: true }; });
  for (const source of ["local-new", "favorites"]) await tools.lyrion_browse.handler({ playerId: "p", source });
  assert.deepEqual(calls.map(c => [c.route, c.body.source]), [["/api/lyrion/browse", "local-new"], ["/api/lyrion/browse", "favorites"]]);
});

const source = fs.readFileSync(require.resolve("../public/lyrion.js"), "utf8");
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));

function element(tag) {
  const node = { tagName: tag, children: [], dataset: {}, attributes: {}, hidden: false, className: "", disabled: false,
    addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; },
    append(...nodes) { this.children.push(...nodes); }, prepend(...nodes) { this.children.unshift(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name]; },
    get textContent() { return this._text ?? this.children.map(c => c.textContent).join(""); }, set textContent(value) { this._text = String(value); this.children = []; } };
  return node;
}
const all = (node, tag) => [node, ...node.children.flatMap(child => all(child, tag))].filter(n => !tag || n.tagName === tag);

function homeHarness() {
  const nodes = Object.fromEntries(["lyrionNewMusic", "lyrionRadios", "lyrionExplore", "lyrionNewMusicStatus", "lyrionRadiosStatus", "lyrionExploreStatus", "lyrionSource"].map(id => [id, element(id === "lyrionSource" ? "select" : "ul")]));
  const calls = [];
  const context = { player: "p1", calls, nodes,
    document: { createElement: element }, $: id => nodes[id],
    run: fn => async () => fn(), artworkImage: (img, url, identity, fallback) => { img.src = url; img.fallback = fallback; },
    api: async (route, body) => { calls.push(["api", route, body]); return {}; },
    refreshStatus: async () => calls.push(["refreshStatus"]), selectTab: (id) => calls.push(["selectTab", id]),
    plateDarkGlyph: () => {}, renderSourceChoices: () => calls.push(["renderSourceChoices"]), home: async () => calls.push(["home", nodes.lyrionSource.value]) };
  vm.runInNewContext(`${section("  function button(label, fn)", "  let showResults=")}${section("  function homeCard(", "  let statusRequest=")}; this.renderHome = renderHome; this.openSource = openSource;`, context);
  return context;
}
const homeData = {
  newMusic: { count: 100, items: [{ title: "Say You Will\nFleetwood Mac", artwork: "/art/1", actions: { play: "play-album", browse: "open-album" } }] },
  favorites: { count: 1, items: [{ title: "SomaFM Drone Zone 256", artwork: "/art/2", actions: { play: "play-drone" } }] },
  explore: { sources: [{ id: "local", title: "Local Library / NAS" }, { id: "radioparadise", title: "Radio Paradise", artwork: "/art/3", actions: { browse: "rp" } },
    { id: "somafm", title: "SomaFM", artwork: "/art/broken", artworkFallback: "/art/radio", actions: { browse: "soma" } }] }
};

test("the Home tab shows new albums with their artist, favorites and explore tiles", () => {
  const h = homeHarness();
  h.renderHome(homeData);
  const [album] = all(h.nodes.lyrionNewMusic, "button");
  assert.deepEqual(all(album, "strong").map(n => n.textContent), ["Say You Will"]);
  assert.deepEqual(all(album, "small").map(n => n.textContent), ["Fleetwood Mac"]);
  assert.equal(album.getAttribute("aria-label"), "Play Say You Will by Fleetwood Mac");
  assert.equal(all(album, "img")[0].src, "/art/1");
  assert.deepEqual(all(h.nodes.lyrionRadios, "button").map(b => b.getAttribute("aria-label")), ["Play SomaFM Drone Zone 256"]);
  assert.deepEqual(all(h.nodes.lyrionExplore, "button").map(b => b.textContent), ["Local Library / NAS", "Radio Paradise", "SomaFM"]);
  assert.deepEqual(all(h.nodes.lyrionExplore, "img").map(i => typeof i.listeners?.load), ["function", "function", "function"]);
  assert.deepEqual(all(h.nodes.lyrionExplore, "img").map(i => [i.src, i.fallback]), [["", ""], ["/art/3", ""], ["/art/broken", "/art/radio"]]);
});

test("tapping an album or a favorite plays it now on the selected player", async () => {
  const h = homeHarness();
  h.renderHome(homeData);
  await all(h.nodes.lyrionNewMusic, "button")[0].onclick();
  await all(h.nodes.lyrionRadios, "button")[0].onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [
    ["api", "queue", { action: "play", token: "play-album" }], ["refreshStatus"],
    ["api", "queue", { action: "play", token: "play-drone" }], ["refreshStatus"]]);
});

test("an explore tile and More open that source in the Sources tab", async () => {
  const h = homeHarness();
  h.renderHome(homeData);
  await all(h.nodes.lyrionExplore, "button")[1].onclick();
  assert.deepEqual(h.calls, [["renderSourceChoices"], ["selectTab", "sources"], ["home", "radioparadise"]]);
  h.calls.length = 0;
  await h.openSource("local-new");
  assert.deepEqual(h.calls, [["renderSourceChoices"], ["selectTab", "sources"], ["home", "local-new"]]);
});

test("a shelf that failed or is empty says so instead of looking blank", () => {
  const h = homeHarness();
  h.renderHome({ newMusic: { items: [], error: "Lyrion: library scan running" }, favorites: { items: [] }, explore: { sources: [] } });
  assert.equal(h.nodes.lyrionNewMusicStatus.textContent, "Could not load new music. Lyrion: library scan running");
  assert.equal(h.nodes.lyrionRadiosStatus.textContent, "No favorites in Lyrion yet. Favorite a station or album in Lyrion and it appears here.");
  assert.equal(h.nodes.lyrionExploreStatus.textContent, "No sources reported by this player.");
  h.renderHome(homeData);
  assert.deepEqual([h.nodes.lyrionNewMusicStatus, h.nodes.lyrionRadiosStatus, h.nodes.lyrionExploreStatus].map(n => n.hidden), [true, true, true]);
});

test("Home is the first Lyrion tab", () => {
  assert.match(source, /const tabDefinitions=\[\['home','Home',\$\('lyrionHomeView'\)\],\['now','Now playing'/);
});

test("a home response that arrives after the player changed is dropped", async () => {
  const h = homeHarness();
  vm.runInContext("this.loadHome = loadHome;", h);
  let answer; h.epoch = 1; h.playerQuery = () => "?playerId=p1";
  h.api = () => new Promise(resolve => { answer = resolve; });
  const pending = h.loadHome();
  h.player = "p2"; h.epoch = 2;
  answer(homeData); await pending;
  assert.deepEqual(h.nodes.lyrionNewMusic.children, []);
  h.api = async () => homeData; h.playerQuery = () => "?playerId=p2";
  await h.loadHome();
  assert.equal(h.nodes.lyrionNewMusic.children.length, 1);
});

test("a favorite that is a folder opens in Sources instead of playing", async () => {
  const h = homeHarness();
  h.history = ["stale"]; h.browse = async request => h.calls.push(["browse", request]);
  h.renderHome({ ...homeData, favorites: { items: [{ title: "Road trip", actions: { browse: "open-folder" } }] } });
  const [folder] = all(h.nodes.lyrionRadios, "button");
  assert.equal(folder.getAttribute("aria-label"), "Open Road trip");
  await folder.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [["selectTab", "sources"], ["browse", { token: "open-folder" }]]);
  assert.equal(h.history.length, 0);
});

function glyphHarness(pixel, coverage) {
  const data = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) if (i < coverage * 32 * 32) data.set([...pixel, 255], i * 4);
  const context = { document: { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data }) }) }) } };
  vm.runInNewContext(section("  function plateDarkGlyph(", "  function homeCard("), context);
  const img = { style: {}, classList: { set: new Set(), toggle(name, on) { on ? this.set.add(name) : this.set.delete(name); } } };
  context.plateDarkGlyph(img);
  return img;
}

test("a dark glyph on a transparent icon, like HQPlayer Bridge's, gets a light plate so it shows on a dark tile", () => {
  const img = glyphHarness([0, 0, 0], 0.14);
  assert.equal(img.classList.set.has("lyrionIconPlate"), true);
  assert.equal(img.style.background, "#ececec");
});

test("coloured, light or full-bleed icons keep their own look", () => {
  for (const [pixel, coverage] of [[[30, 215, 96], 0.5], [[240, 240, 240], 0.3], [[10, 10, 10], 0.95], [[0, 0, 0], 0]]) {
    const img = glyphHarness(pixel, coverage);
    assert.equal(img.classList.set.has("lyrionIconPlate"), false, JSON.stringify([pixel, coverage]));
    assert.equal(img.style.background, "");
  }
});

test("once an explore icon has fallen back to the stock radio icon it stops retrying the broken one", () => {
  const h = homeHarness();
  h.renderHome(homeData);
  const [, rp, soma] = all(h.nodes.lyrionExplore, "img");
  for (const img of [rp, soma]) img.dataset.retryAt = "123";
  soma.src = "http://rh.example/art/radio"; soma.listeners.load();
  rp.listeners.load();
  assert.equal(soma.dataset.retryAt, undefined);
  assert.equal(rp.dataset.retryAt, "123");
});
