"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { LyrionClient } = require("../src/lyrionClient");

const TIDAL_ROW = { id: 203188, title: "Big Beans", artist: "Boris Blank", album: "Electrified", url: "tidal://77661066.flc", coverart: "1", remote: "1", "playlist index": 0 };
const COVER = "e6617941";

function lmsWithTags(row) {
  const calls = [];
  const rpc = async (player, cmd) => {
    calls.push(cmd);
    const tags = String(cmd.find(part => String(part).startsWith("tags:")) || "").slice(5);
    const t = { ...row };
    if (tags.includes("c")) t.coverid = COVER;
    if (tags.includes("J")) t.artwork_track_id = COVER;
    if (cmd[0] === "titles") return { count: 1, titles_loop: [t] };
    return { mode: "play", player_connected: 1, playlist_tracks: 1, playlist_cur_index: 0, playlist_loop: [t] };
  };
  return { rpc, calls };
}

function coverPath(artwork) {
  return new URL(artwork, "http://rh.example").searchParams.get("path");
}

function client(row) {
  const c = new LyrionClient();
  const lms = lmsWithTags(row);
  c.rpc = lms.rpc;
  c.hqplayerFor = async () => null;
  c.bridgeModels = async () => ({ list: [] });
  c.albumTrackCount = async () => 0;
  return c;
}

test("a streamed track playing on Lyrion shows its cover id, not its track id, which Lyrion answers with a 500", async () => {
  const status = await client(TIDAL_ROW).status("p1");
  assert.equal(coverPath(status.nowPlaying.artwork), `/music/${COVER}/cover.jpg`);
});

test("queued streamed tracks use their cover id as artwork", async () => {
  const status = await client(TIDAL_ROW).status("p1", 0, 50);
  assert.equal(status.queue.length, 1);
  assert.equal(coverPath(status.queue[0].artwork), `/music/${COVER}/cover.jpg`);
});

test("artwork falls back to artwork_track_id when Lyrion sends no coverid", () => {
  const c = new LyrionClient();
  assert.equal(coverPath(c.artwork({ id: 203188, coverart: "1", artwork_track_id: COVER })), `/music/${COVER}/cover.jpg`);
});

test("library track listings use the cover id as artwork", async () => {
  const c = client({ ...TIDAL_ROW, url: "file:///nas/a.flac", remote: "0" });
  const result = await c.browse("p1", { source: "local" });
  assert.equal(coverPath(result.items[0].artwork), `/music/${COVER}/cover.jpg`);
});
