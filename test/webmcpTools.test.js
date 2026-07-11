"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "..", "public", "webmcpTools.js"), "utf8");

class MockAbortController {
  constructor() {
    this.signal = {};
  }

  abort() {}
}

function runScript({ bridge = {}, registerTool = null } = {}) {
  const registered = [];
  const context = {
    window: {
      RabbitHoleWebMcpBridge: bridge
    },
    document: {
      ...(registerTool ? {
        modelContext: {
          registerTool(tool) {
            registered.push(tool);
            registerTool(tool);
          }
        }
      } : {}),
      dispatchEvent() {}
    },
    CustomEvent: function CustomEvent(name, options) {
      this.name = name;
      this.detail = options?.detail;
    },
    AbortController: MockAbortController
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return { context, registered };
}

test("WebMCP registry is a no-op without browser support", () => {
  const { context, registered } = runScript({
    bridge: {
      getStatus: async () => ({ ok: true })
    }
  });

  assert.equal(context.window.RabbitHoleWebMcp.supported, false);
  assert.deepEqual(Array.from(context.window.RabbitHoleWebMcp.registered), []);
  assert.equal(registered.length, 0);
});

test("WebMCP registry exposes Rabbit Hole tools when browser support exists", async () => {
  const bridge = {
    getStatus: async () => ({ ok: true }),
    searchRabbitHole: async () => ({ tracks: [] }),
    queueDisplayedTracks: async () => ({ queuedCount: 0 }),
    sendDisplayedTracksToTidal: async () => ({ addedCount: 0 }),
    getStandbyPool: async () => ({ count: 0, tracks: [] }),
    refreshStandbyPool: async () => ({ count: 0, tracks: [] }),
    queueStandbyTracks: async () => ({ queuedCount: 0 }),
    sendStandbyTracksToTidal: async () => ({ addedCount: 0 }),
    createTidalPlaylist: async () => ({ playlist: { title: "Test" } }),
    addNowPlayingToTidal: async () => ({ added: true }),
    rateNowPlaying: async () => ({ rating: "love" }),
    explainLastRejections: async () => ({ discardedCount: 0 }),
    inspectGenreProfile: async () => ({ genreProfiles: { count: 0 } })
  };
  const { context, registered } = runScript({
    bridge,
    registerTool() {}
  });

  assert.equal(context.window.RabbitHoleWebMcp.supported, true);
  assert.deepEqual(Array.from(context.window.RabbitHoleWebMcp.registered), [
    "get_rabbit_hole_status",
    "search_rabbit_hole",
    "queue_rabbit_hole_tracks",
    "send_rabbit_hole_to_tidal_playlist",
    "get_standby_pool",
    "refresh_standby_pool",
    "queue_standby_tracks",
    "send_standby_to_tidal_playlist",
    "create_tidal_playlist",
    "add_now_playing_to_tidal_playlist",
    "rate_now_playing",
    "explain_last_rejections",
    "inspect_genre_profile"
  ]);
  assert.equal(registered.length, 13);

  const output = await registered[0].execute({});
  assert.match(output, /"ok": true/);
});
