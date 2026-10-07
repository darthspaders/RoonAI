"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LyrionClient } = require("../src/lyrionClient");
const { createLyrionApi } = require("../src/lyrionApi");

const server = "http://lms.example:9000";
const albumUrl = "db:album.title=Same%20album&contributor.name=Same%20artist";
const base = { actions: Object.fromEntries([["play", "load"], ["add", "add"], ["add-hold", "insert"]].map(([kind, cmd]) =>
  [kind, { cmd: ["playlistcontrol"], params: { cmd, menu: 1 }, itemsParams: "commonParams" }])) };
function album(id, extra = {}) {
  return { text: "Same album\nSame artist", commonParams: { album_id: id, performance: "", ...extra },
    presetParams: { favorites_url: albumUrl, favorites_type: "playlist" } };
}
function artist(id) {
  return { text: "Same artist", commonParams: { artist_id: id },
    presetParams: { favorites_url: "db:contributor.name=Same%20artist", favorites_type: "playlist" } };
}
function menu(client, items, player = "p1") {
  return client.menu({ count: items.length, base, item_loop: items }, player, "Local").items;
}
function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyrion-library-reference-"));
  const file = path.join(dir, "items.json");
  t.after(() => {
    for (const name of [file, `${file}.tmp`]) if (fs.existsSync(name)) fs.unlinkSync(name);
    fs.rmdirSync(dir);
  });
  return file;
}

test("same-title editions have distinct durable native album references instead of sharing their favorite URL", () => {
  const client = new LyrionClient({ baseUrl: server });
  const legacy = client.items.remember({ source: "Local", title: "Old discovery", url: albumUrl });
  const [first, second] = menu(client, [album(101), album(202)]);
  assert.notEqual(first.referenceId, second.referenceId);
  assert.notEqual(first.referenceId, legacy.referenceId);
  assert.notEqual(second.referenceId, legacy.referenceId);
  assert.deepEqual([first.sourceId, second.sourceId], ["101", "202"]);
  assert.equal(menu(client, [album("202")])[0].referenceId, second.referenceId);
  assert.equal(client.items.get(first.referenceId).libraryIdentity.type, "album");
});

test("persisted album references play, add and insert with the original native ID and selection filters", async t => {
  const file = tempStore(t), client = new LyrionClient({ baseUrl: server, itemsFile: file });
  const [first, second] = menu(client, [album(101), album(202, { performance: "Studio", library_id: "7", role_id: "ALBUMARTIST" })]);
  const restored = new LyrionClient({ baseUrl: server, itemsFile: file });
  const calls = [];
  restored.rpc = async (player, command) => calls.push([player, command]);
  for (const [kind, cmd] of [["play", "load"], ["add", "add"], ["next", "insert"]]) {
    await restored.executeExact("p1", { referenceId: second.referenceId }, kind);
    assert.deepEqual(calls.at(-1), ["p1", ["playlistcontrol", `cmd:${cmd}`, "menu:1", "album_id:202", "performance:Studio", "library_id:7", "role_id:ALBUMARTIST"]]);
  }
  await restored.executeExact("p1", { referenceId: first.referenceId }, "play");
  assert.deepEqual(calls.at(-1)[1], ["playlistcontrol", "cmd:load", "menu:1", "album_id:101", "performance:"]);
  assert.deepEqual(restored.items.get(second.referenceId).sourcePayload.commonParams,
    { album_id: 202, performance: "Studio", library_id: "7", role_id: "ALBUMARTIST" });
  assert.equal(menu(restored, [album(202, { role_id: "ALBUMARTIST", library_id: "7", performance: "Studio" })])[0].referenceId, second.referenceId);
  assert.notEqual(menu(restored, [album(202, { performance: "Live", library_id: "7", role_id: "ALBUMARTIST" })])[0].referenceId, second.referenceId);
});

test("same-named artists and collection types preserve distinct native identities across persistence", async t => {
  const file = tempStore(t), client = new LyrionClient({ baseUrl: server, itemsFile: file });
  const [first, second, sameNumberAlbum] = menu(client, [artist(42), artist(99), album(42)]);
  assert.equal(new Set([first.referenceId, second.referenceId, sameNumberAlbum.referenceId]).size, 3);
  const restored = new LyrionClient({ baseUrl: server, itemsFile: file });
  assert.equal(restored.items.get(first.referenceId).libraryIdentity.type, "artist");
  const calls = [];
  restored.rpc = async (player, command) => calls.push(command);
  for (const [kind, cmd] of [["play", "load"], ["add", "add"], ["next", "insert"]]) {
    await restored.executeExact("p1", { referenceId: second.referenceId }, kind);
    assert.deepEqual(calls.at(-1), ["playlistcontrol", `cmd:${cmd}`, "menu:1", "artist_id:99"]);
  }
});

test("library references are bound to their originating server and player and never fall back to their URL", async t => {
  const file = tempStore(t), client = new LyrionClient({ baseUrl: server, itemsFile: file });
  const [item] = menu(client, [album(101)]);
  const [otherPlayer] = menu(client, [album(101)], "p2");
  assert.notEqual(item.referenceId, otherPlayer.referenceId);
  let writes = 0;
  client.rpc = async () => writes++;
  await assert.rejects(client.executeExact("p2", { referenceId: item.referenceId }, "play"), /another Lyrion server or player/);
  assert.equal(writes, 0);
  const otherServer = new LyrionClient({ baseUrl: "http://other-lms.example:9000", itemsFile: file });
  otherServer.rpc = client.rpc;
  await assert.rejects(otherServer.executeExact("p1", { referenceId: item.referenceId }, "add"), /another Lyrion server or player/);
  assert.equal(writes, 0);
});

test("disabled native actions remain disabled for references, including collections with no favorite URL", async () => {
  const client = new LyrionClient({ baseUrl: server });
  const row = album(101);
  row.actions = { play: null, "add-hold": null };
  delete row.presetParams;
  const [item] = menu(client, [row]);
  assert.ok(item.referenceId);
  let command;
  client.rpc = async (player, cmd) => { command = cmd; };
  await client.executeExact("p1", { referenceId: item.referenceId }, "add");
  assert.deepEqual(command, ["playlistcontrol", "cmd:add", "menu:1", "album_id:101", "performance:"]);
  await assert.rejects(client.executeExact("p1", { referenceId: item.referenceId }, "play"), /does not support that exact action/);
  await assert.rejects(client.executeExact("p1", { referenceId: item.referenceId }, "next"), /does not support that exact action/);
});

test("an inconsistent persisted native action fails closed instead of selecting another album", async () => {
  const client = new LyrionClient({ baseUrl: server });
  const [item] = menu(client, [album(101)]);
  client.items.get(item.referenceId).libraryActions.play.params.album_id = 202;
  let writes = 0;
  client.rpc = async () => writes++;
  await assert.rejects(client.executeExact("p1", { referenceId: item.referenceId }, "play"), /does not support that exact action/);
  assert.equal(writes, 0);
});

test("legacy title-query collection references fail before a queue handoff or a native favorite write", async () => {
  const client = new LyrionClient({ baseUrl: server });
  const calls = [];
  client.rpc = async (...args) => calls.push(args);
  client.requirePlayer = async () => {};
  client.artistStations = { stop: () => calls.push("station stopped") };
  let body;
  const api = createLyrionApi({ client, file: "does-not-exist", readJson: async () => body, sendJson: () => {},
    roon: { getState: () => ({ zones: [{ zone_id: "r", state: "playing" }] }), control: async () => calls.push("roon paused") } });
  for (const url of [albumUrl, "db:contributor.name=Same%20artist"]) {
    const item = client.items.remember({ source: "Local", title: "Legacy collection", url });
    for (const action of ["play", "add", "next"]) {
      body = { playerId: "p1", referenceId: item.referenceId, action };
      await assert.rejects(api.handle({ method: "POST" }, {}, new URL("http://rh.example/api/lyrion/queue")), /lacks an exact album or artist ID/);
    }
    body = { playerId: "p1", referenceId: item.referenceId, action: "add" };
    await assert.rejects(api.handle({ method: "POST" }, {}, new URL("http://rh.example/api/lyrion/native-favorites")), /cannot be saved by a title-query URL/);
  }
  assert.deepEqual(calls, []);
});

test("the API validates collection ownership before pausing Roon and retains the selected player's exact action", async () => {
  const client = new LyrionClient({ baseUrl: server });
  const [item] = menu(client, [album(202)]);
  const calls = [];
  client.rpc = async (player, command) => calls.push([player, command]);
  client.requirePlayer = async () => {};
  let body = { playerId: "p2", referenceId: item.referenceId, action: "play" };
  const api = createLyrionApi({ client, file: "does-not-exist", readJson: async () => body, sendJson: () => {},
    roon: { getState: () => ({ zones: [{ zone_id: "r", state: "playing" }] }), control: async () => calls.push("roon paused") } });
  await assert.rejects(api.handle({ method: "POST" }, {}, new URL("http://rh.example/api/lyrion/queue")), /another Lyrion server or player/);
  assert.deepEqual(calls, []);
  body = { ...body, playerId: "p1" };
  await api.handle({ method: "POST" }, {}, new URL("http://rh.example/api/lyrion/queue"));
  assert.deepEqual(calls, ["roon paused", ["p1", ["playlistcontrol", "cmd:load", "menu:1", "album_id:202", "performance:"]]]);
  calls.length = 0;
  body = { ...body, action: "add" };
  await assert.rejects(api.handle({ method: "POST" }, {}, new URL("http://rh.example/api/lyrion/native-favorites")), /cannot be saved by a title-query URL/);
  assert.deepEqual(calls, []);
});

test("local track and SoundCloud references keep their existing URL identity and queue behavior", async () => {
  const client = new LyrionClient({ baseUrl: server });
  const url = "file:///nas/album/song.flac";
  const [track] = menu(client, [{ text: "Song", commonParams: { album_id: 202, artist_id: 99, track_id: 10 },
    presetParams: { favorites_url: url, favorites_type: "audio" } }]);
  assert.equal(track.libraryIdentity, undefined);
  assert.equal(menu(client, [{ text: "Song again", presetParams: { favorites_url: url, favorites_type: "audio" } }])[0].referenceId, track.referenceId);
  const soundcloud = client.items.remember({ source: "SoundCloud", title: "Mix", url: "soundcloud://soundcloud:tracks:123", soundcloudUrn: "soundcloud:tracks:123" });
  const calls = [];
  client.rpc = async (player, command) => calls.push(command);
  for (const [kind, cmd] of [["play", "play"], ["add", "add"], ["next", "insert"]]) {
    await client.executeExact("p2", { referenceId: track.referenceId }, kind);
    assert.deepEqual(calls.at(-1), ["playlist", cmd, url]);
    await client.executeExact("p2", { referenceId: soundcloud.referenceId }, kind);
    assert.deepEqual(calls.at(-1), ["playlist", cmd, "soundcloud://soundcloud:tracks:123"]);
  }
  assert.deepEqual(client.exactCommand({ soundcloudTrack: "123" }, "next"), ["playlist", "insert", "soundcloud://soundcloud:tracks:123"]);
});
