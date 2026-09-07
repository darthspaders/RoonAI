"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { RoonClient } = require("../src/roonClient");

test("Roon internet radio stations are listed from the radio hierarchy", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1", outputs: [{ output_id: "output-1" }] });
  const browseCalls = [];
  const loadCalls = [];
  roon.browse = {
    browse(payload, callback) {
      browseCalls.push(payload);
      callback(null, {});
    },
    load(payload, callback) {
      loadCalls.push(payload);
      callback(null, {
        list: { title: "My Live Radio" },
        items: [
          { title: "My Live Radio", subtitle: "Saved stations", item_key: "my-live-radio", image_key: "folder-img", hint: "list" },
          { title: "Progressive -DI.FM", subtitle: "Internet radio", item_key: "station-1", image_key: "img-1", hint: "action" },
          { title: "Add Station", subtitle: "", item_key: "add", hint: "list" },
          { title: "Play", subtitle: "", item_key: "action", hint: "action" }
        ]
      });
    }
  };

  const result = await roon.listRadioStations("zone-1", { refresh: true });

  assert.equal(result.title, "My Live Radio");
  assert.equal(result.hierarchy, "internet_radio");
  assert.equal(result.count, 2);
  assert.equal(result.stationCount, 1);
  assert.deepEqual(result.items[0], {
    id: "my-live-radio",
    title: "My Live Radio",
    subtitle: "Saved stations",
    imageKey: "folder-img",
    hint: "list",
    kind: "folder",
    playable: false,
    browseable: true
  });
  assert.deepEqual(result.stations[0], {
    id: "station-1",
    title: "Progressive -DI.FM",
    subtitle: "Internet radio",
    imageKey: "img-1",
    hint: "action",
    kind: "station",
    playable: true,
    browseable: false
  });
  assert.equal(result.items[1].kind, "station");
  assert.equal(browseCalls[0].hierarchy, "internet_radio");
  assert.equal(browseCalls[0].zone_or_output_id, "output-1");
  assert.equal(browseCalls[0].refresh_list, undefined);
  assert.equal(loadCalls[0].hierarchy, "internet_radio");
});

test("Roon radio listing falls back through general browse when direct radio is empty", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1", outputs: [{ output_id: "output-1" }] });
  const browseCalls = [];
  let openedRadioRoot = false;
  roon.browse = {
    browse(payload, callback) {
      browseCalls.push(payload);
      if (payload.hierarchy === "browse" && payload.item_key === "live-radio") openedRadioRoot = true;
      callback(null, {});
    },
    load(payload, callback) {
      if (payload.hierarchy === "internet_radio") {
        callback(null, {
          list: { title: "My Live Radio" },
          items: []
        });
        return;
      }
      if (payload.hierarchy === "browse" && !openedRadioRoot) {
        callback(null, {
          list: { title: "Browse" },
          items: [
            { title: "Albums", subtitle: "", item_key: "albums", hint: "list" },
            { title: "Live Radio", subtitle: "Internet radio", item_key: "live-radio", hint: "list" }
          ]
        });
        return;
      }
      callback(null, {
        list: { title: "Live Radio" },
        items: [
          { title: "Progressive -DI.FM", subtitle: "Internet radio", item_key: "station-1", image_key: "img-1", hint: "action_list" }
        ]
      });
    }
  };

  const result = await roon.listRadioStations("zone-1");

  assert.equal(result.hierarchy, "browse");
  assert.equal(result.title, "Live Radio");
  assert.equal(result.itemKey, "live-radio");
  assert.equal(result.count, 1);
  assert.equal(result.stationCount, 1);
  assert.equal(result.items[0].playable, true);
  assert.equal(browseCalls[0].hierarchy, "internet_radio");
  assert.equal(browseCalls[1].hierarchy, "browse");
  assert.equal(browseCalls[2].item_key, "live-radio");
});

test("Roon internet radio station play selects the exposed play action", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.radioSession = "radio-session";
  roon.zones.set("zone-1", { zone_id: "zone-1", outputs: [{ output_id: "output-1" }] });
  const browseCalls = [];
  roon.browse = {
    browse(payload, callback) {
      browseCalls.push(payload);
      callback(null, browseCalls.length === 1 ? { action: "list" } : {});
    },
    load(_payload, callback) {
      callback(null, {
        items: [
          { title: "Play", subtitle: "", item_key: "play-station", hint: "action" }
        ]
      });
    }
  };

  const result = await roon.playRadioStation("station-1", "zone-1", { title: "Progressive -DI.FM" });

  assert.equal(result.played, true);
  assert.equal(result.action, "Play");
  assert.equal(browseCalls[0].item_key, "station-1");
  assert.equal(browseCalls[0].hierarchy, "internet_radio");
  assert.equal(browseCalls[1].item_key, "play-station");
  assert.equal(browseCalls[1].zone_or_output_id, "output-1");
});

test("Roon internet radio station action rows can play directly", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.radioSession = "radio-session";
  roon.zones.set("zone-1", { zone_id: "zone-1", outputs: [{ output_id: "output-1" }] });
  let loadCalled = false;
  const browseCalls = [];
  roon.browse = {
    browse(payload, callback) {
      browseCalls.push(payload);
      callback(null, { action: "none" });
    },
    load(_payload, callback) {
      loadCalled = true;
      callback(null, { items: [] });
    }
  };

  const result = await roon.playRadioStation("station-1", "zone-1", { title: "Progressive -DI.FM" });

  assert.equal(result.played, true);
  assert.equal(result.action, "Play station");
  assert.equal(loadCalled, false);
  assert.equal(browseCalls[0].item_key, "station-1");
  assert.equal(browseCalls[0].zone_or_output_id, "output-1");
});

test("Roon playlist delete follows a delete confirmation action", async () => {
  const roon = new RoonClient();
  const browseCalls = [];
  let loadCount = 0;
  roon.browse = {
    browse(payload, callback) {
      browseCalls.push(payload);
      if (payload.item_key === "delete-playlist") {
        callback(null, { action: "list" });
        return;
      }
      if (payload.item_key === "confirm-delete") {
        callback(null, { action: "message", message: "Deleted" });
        return;
      }
      callback(null, { action: "list", list: { title: "Weekend" } });
    },
    load(_payload, callback) {
      loadCount += 1;
      if (loadCount === 1) {
        callback(null, {
          list: { title: "Playlists" },
          items: [
            { title: "Weekend", subtitle: "12 tracks", item_key: "playlist-key", hint: "list" }
          ]
        });
        return;
      }
      if (loadCount === 2) {
        callback(null, {
          list: { title: "Weekend" },
          items: [
            { title: "Play", subtitle: "", item_key: "play-playlist", hint: "action" },
            { title: "Delete Playlist", subtitle: "", item_key: "delete-playlist", hint: "action" }
          ]
        });
        return;
      }
      callback(null, {
        list: { title: "Delete Playlist" },
        items: [
          { title: "Cancel", subtitle: "", item_key: "cancel-delete", hint: "action" },
          { title: "Delete", subtitle: "", item_key: "confirm-delete", hint: "action" }
        ]
      });
    }
  };

  const result = await roon.deletePlaylist("stale-key", "Weekend");

  assert.equal(result.deleted, true);
  assert.equal(result.action, "Delete Playlist");
  assert.equal(result.confirmationAction, "Delete");
  assert.equal(browseCalls[1].item_key, "playlist-key");
  assert.equal(browseCalls[2].item_key, "delete-playlist");
  assert.equal(browseCalls[3].item_key, "confirm-delete");
});

test("Roon artist-anchor queries do not match title-only collisions", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1" });

  let loadCount = 0;
  roon.browse = {
    browse(_payload, callback) {
      callback(null, {});
    },
    load(_payload, callback) {
      loadCount += 1;
      if (loadCount === 1) {
        callback(null, {
          items: [
            { title: "Tracks", subtitle: "2 results", item_key: "tracks", hint: "list" }
          ]
        });
        return;
      }
      callback(null, {
        items: [
          {
            title: "Matter of Time (Original Mix)",
            subtitle: "Pressplays - Matter of Time",
            item_key: "bad-title-only",
            hint: "audio"
          },
          {
            title: "Progressive House",
            subtitle: "Neuromancer - Progressive House",
            item_key: "bad-genre-title",
            hint: "audio"
          },
          {
            title: "Summer House Music",
            subtitle: "Ibiza Dance Party, Bossa Cafe en Ibiza, Ibiza Lounge Club - Summer House Music",
            item_key: "bad-lifestyle-account",
            hint: "audio"
          },
          {
            title: "Large Bells. (Melodic Vocal Progressive House 2026)",
            subtitle: "Aldina - Large Bells",
            item_key: "bad-genre-year-tag",
            hint: "audio"
          },
          {
            title: "Deep Progressive House",
            subtitle: "Oro Loco - Deep Progressive House",
            item_key: "bad-style-title",
            hint: "audio"
          },
          {
            title: "Music (Pumping Club Cut)",
            subtitle: "Festival Shaker, Mirwais - Music",
            item_key: "bad-generic-artist",
            hint: "audio"
          },
          {
            title: "HYPNOTIC WAVES",
            subtitle: "Dark Matter - Hypnotic Waves",
            item_key: "bad-one-word-anchor-prefix",
            hint: "audio"
          },
          {
            title: "Hypnotic",
            subtitle: "Grey Matter - Hypnotic",
            item_key: "bad-one-word-anchor-suffix",
            hint: "audio"
          },
          {
            title: "2025",
            subtitle: "Black Matter Project - 2025",
            item_key: "bad-year-title",
            hint: "audio"
          },
          {
            title: "A Scene Track",
            subtitle: "Matter - Scene Album",
            item_key: "good-artist",
            hint: "audio"
          }
        ]
      });
    }
  };

  const result = await roon.searchTrackCandidates("Matter progressive house", "zone-1", { limit: 20 });

  assert.deepEqual(result.tracks.map((track) => track.artist), ["Matter"]);
});

test("deep Roon discovery can gather a large fresh candidate pool", async () => {
  const roon = new RoonClient();
  roon.browse = {};
  const calls = [];

  roon.searchTrackCandidates = async (query, zoneId, options = {}) => {
    calls.push({ query, zoneId, limit: options.limit });
    return {
      query,
      rawCount: options.limit,
      searchedCategory: null,
      tracks: Array.from({ length: 20 }, (_, index) => ({
        artist: `Artist ${calls.length}-${index}`,
        title: `Track ${calls.length}-${index}`,
        album: `Album ${calls.length}`,
        query
      }))
    };
  };

  const result = await roon.discoverQueueableTracks({
    request: "Find late night tribal funky dark deep hypnotic driving progressive house",
    genres: "progressive house",
    mood: "late night, tribal, funky, dark, deep, hypnotic, driving",
    years: "2020-2026",
    disableRoonLabelQueries: "true"
  }, "zone-1", {
    targetCount: 10,
    candidateLimit: 1200,
    candidateLimitMax: 1500,
    maxQueries: 60,
    searchLimit: 120,
    searchSummaryLimit: 48,
    verifyQueueActions: "",
    modelQueryLimit: 0
  });

  assert.equal(calls.length, 60);
  assert.equal(calls.every((call) => call.zoneId === "zone-1"), true);
  assert.equal(calls.every((call) => call.limit === 120), true);
  assert.equal(calls.some((call) => /^meanwhile\s+20\d{2}$/i.test(call.query)), false);
  assert.equal(calls.some((call) => /^(?:sudbeat|mango alley|movement recordings|meanwhile)\b/i.test(call.query)), false);
  assert.equal(result.tracks.length, 10);
  assert.equal(result.alternates.length, 1190);
  assert.equal(result.verification.candidates, 1200);
  assert.equal(result.verification.candidateLimit, 1200);
  assert.equal(result.verification.maxQueries, 60);
  assert.equal(result.verification.searchLimit, 120);
});

test("Pure Search Roon discovery stays anchored to the requested artist", async () => {
  const roon = new RoonClient();
  const calls = [];

  roon.searchTrackCandidates = async (query, zoneId, options = {}) => {
    calls.push({ query, zoneId, limit: options.limit });
    return {
      query,
      rawCount: 0,
      searchedCategory: null,
      tracks: []
    };
  };

  await roon.discoverQueueableTracks({
    request: "find more tracks by Rafael Osmo",
    genres: "progressive house, progressive trance, deep progressive",
    years: "2020-2026",
    scoringMode: "pure",
    disableRoonLabelQueries: "true",
    llmSearchPlan: {
      seedArtists: ["Guy J"],
      candidateArtists: ["Khen"],
      searchQueries: ["Guy J progressive trance", "Rafael Osmo progressive house"]
    }
  }, "zone-1", {
    targetCount: 10,
    candidateLimit: 80,
    candidateLimitMax: 100,
    maxQueries: 12,
    searchLimit: 60,
    enableArtistCrawl: false,
    modelQueryLimit: 0
  });

  assert.ok(calls.length > 0);
  assert.equal(calls.every((call) => /rafael osmo/i.test(call.query)), true);
  assert.equal(calls.some((call) => /\b(?:guy j|khen|hernan cattaneo|nick warren)\b/i.test(call.query)), false);
});

test("Pure Search Roon artist crawl seeds the requested artist, not scene anchors", async () => {
  const roon = new RoonClient();
  const visited = [];

  roon.resolveArtistSearchPage = async (artist) => {
    visited.push(artist);
    return {
      artist,
      session: `session-${artist}`,
      hierarchy: "search",
      items: [{ title: "Play Artist", subtitle: "", item_key: `play-${artist}`, hint: "action_list" }]
    };
  };
  roon.crawlArtistPageTracks = async () => ({ tracks: [], similarArtists: [], crawledContainers: 0 });
  roon.fallbackArtistTrackSearch = async (artist) => [{
    title: "Rafael Tune",
    artist,
    album: "Rafael Album",
    query: artist,
    discoverySource: "Roon artist search crawl",
    discoveryLane: "artist-crawl",
    roon: { verified: true, artistCreditConfirmed: artist }
  }];

  const result = await roon.discoverArtistCrawlTracks({
    request: "find more tracks by Rafael Osmo",
    genres: "progressive house, progressive trance, deep progressive",
    years: "2020-2026",
    scoringMode: "pure",
    llmSearchPlan: {
      seedArtists: ["Guy J"],
      candidateArtists: ["Khen"]
    }
  }, "zone-1", {
    artistSeedLimit: 4,
    candidateLimit: 20,
    includeSimilarArtists: false
  });

  assert.deepEqual(result.verification.seeds, ["Rafael Osmo"]);
  assert.deepEqual(visited, ["Rafael Osmo"]);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].artist, "Rafael Osmo");
});

test("Roon artist crawl harvests exact artist, albums, and similar artists", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1" });
  const sessions = new Map();

  function stateFor(payload) {
    const session = payload.multi_session_key;
    const state = sessions.get(session) || {};
    sessions.set(session, state);
    return state;
  }

  roon.browse = {
    browse(payload, callback) {
      const state = stateFor(payload);
      if (payload.input) {
        state.artist = payload.input;
        state.page = "search";
      } else if (payload.item_key) {
        state.page = payload.item_key;
      }
      callback(null, {});
    },
    load(payload, callback) {
      const state = stateFor(payload);
      const artist = state.artist;
      const page = state.page;
      if (page === "search") {
        callback(null, { items: [{ title: "Artists", subtitle: "2 results", item_key: "artists", hint: "list" }] });
        return;
      }
      if (page === "artists") {
        callback(null, {
          items: [
            { title: `Dark ${artist}`, subtitle: "", item_key: `dark-${artist}`, hint: "artist" },
            { title: artist, subtitle: "", item_key: `artist-${artist}`, hint: "artist" }
          ]
        });
        return;
      }
      if (page === "artist-Seed Artist") {
        callback(null, {
          items: [
            { title: "Top Tracks", subtitle: "", item_key: "seed-top", hint: "list" },
            { title: "Albums", subtitle: "", item_key: "seed-albums", hint: "list" },
            { title: "Similar Artists", subtitle: "", item_key: "seed-similar", hint: "list" }
          ]
        });
        return;
      }
      if (page === "seed-top") {
        callback(null, {
          items: [
            { title: "Seed Tune", subtitle: "Seed Artist - Seed Album", item_key: "seed-track", hint: "audio" }
          ]
        });
        return;
      }
      if (page === "seed-albums") {
        callback(null, {
          items: [
            { title: "Seed Album", subtitle: "Seed Artist", item_key: "seed-album", hint: "album" }
          ]
        });
        return;
      }
      if (page === "seed-album") {
        callback(null, {
          items: [
            { title: "Album Tune", subtitle: "Seed Artist - Seed Album", item_key: "seed-album-track", hint: "audio" }
          ]
        });
        return;
      }
      if (page === "seed-similar") {
        callback(null, {
          items: [
            { title: "Similar Artist", subtitle: "", item_key: "similar-artist", hint: "artist" }
          ]
        });
        return;
      }
      if (page === "artist-Similar Artist") {
        callback(null, {
          items: [
            { title: "Top Tracks", subtitle: "", item_key: "similar-top", hint: "list" }
          ]
        });
        return;
      }
      if (page === "similar-top") {
        callback(null, {
          items: [
            { title: "Similar Tune", subtitle: "Similar Artist - Similar Album", item_key: "similar-track", hint: "audio" }
          ]
        });
        return;
      }
      callback(null, { items: [] });
    }
  };

  const result = await roon.discoverArtistCrawlTracks({
    llmSearchPlan: {
      seedArtists: ["Seed Artist"]
    }
  }, "zone-1", {
    artistSeedLimit: 1,
    candidateLimit: 20,
    includeSimilarArtists: true,
    maxSimilarSeeds: 2,
    similarArtistsPerSeed: 2
  });

  assert.deepEqual(result.tracks.map((track) => track.title), [
    "Seed Tune",
    "Album Tune",
    "Similar Tune"
  ]);
  assert.equal(result.tracks[2].discoveryLane, "similar-artist-crawl");
  assert.equal(result.verification.visitedArtists, 2);
});

test("Roon artist crawl follows externally supplied similar artist seeds", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1" });

  roon.resolveArtistSearchPage = async (artist) => ({
    artist,
    session: `session-${artist}`,
    hierarchy: "search",
    items: [{ title: "Play Artist", subtitle: "", item_key: `play-${artist}`, hint: "action_list" }]
  });
  roon.crawlArtistPageTracks = async () => ({ tracks: [], similarArtists: [], crawledContainers: 0 });
  roon.fallbackArtistTrackSearch = async (artist) => artist === "Related Artist"
    ? [{
        title: "Related Tune",
        artist: "Related Artist",
        album: "Related Album",
        query: "Related Artist",
        discoverySource: "Roon artist search crawl",
        discoveryLane: "artist-crawl",
        roon: { verified: true }
      }]
    : [];

  const result = await roon.discoverArtistCrawlTracks({
    llmSearchPlan: {
      seedArtists: ["Seed Artist"]
    },
    similarArtistSeeds: ["Related Artist"]
  }, "zone-1", {
    artistSeedLimit: 1,
    candidateLimit: 20,
    includeSimilarArtists: true,
    maxSimilarSeeds: 2
  });

  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].title, "Related Tune");
  assert.equal(result.tracks[0].discoverySource, "Roon similar artist crawl");
  assert.equal(result.tracks[0].discoveryLane, "similar-artist-crawl");
  assert.deepEqual(result.verification.similarArtistSeeds, ["Related Artist"]);
  assert.equal(result.verification.visitedArtists, 2);
});

test("Roon artist fallback crawl requires exact artist credit", async () => {
  const roon = new RoonClient();
  roon.searchTrackCandidates = async () => ({
    tracks: [
      {
        title: "Angles",
        artist: "Jonas Blue, Sevenn, Arno Kammermeier, Guy James Robin",
        album: "Angles",
        roon: { verified: true }
      },
      {
        title: "Just Rain",
        artist: "Guy J",
        album: "Just Rain",
        roon: { verified: true }
      },
      {
        title: "Velvet Sky",
        artist: "Hernán Cattáneo, Barry Jamieson",
        album: "Velvet Sky",
        roon: { verified: true }
      }
    ]
  });

  const guyJ = await roon.fallbackArtistTrackSearch("Guy J", "zone-1");
  assert.deepEqual(guyJ.map((track) => track.title), ["Just Rain"]);
  assert.equal(guyJ[0].roon.artistCreditConfirmed, "Guy J");
  assert.ok(guyJ[0].statusChecks.includes("Exact artist credit confirmed"));

  const hernan = await roon.fallbackArtistTrackSearch("Hernan Cattaneo", "zone-1");
  assert.deepEqual(hernan.map((track) => track.title), ["Velvet Sky"]);
});

test("Roon queue resolver tries title-first query after artist-first collision", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1" });
  const sessions = new Map();
  const inputs = [];

  function stateFor(payload) {
    const session = payload.multi_session_key;
    const state = sessions.get(session) || {};
    sessions.set(session, state);
    return state;
  }

  roon.browse = {
    browse(payload, callback) {
      const state = stateFor(payload);
      if (payload.input) {
        state.query = payload.input;
        state.page = "root";
        inputs.push(payload.input);
      } else if (payload.item_key === "tracks") {
        state.page = "tracks";
      } else if (payload.item_key === "exact-no-regrets") {
        state.page = "actions";
      } else if (payload.item_key === "queue-action") {
        state.page = "queued";
      }
      callback(null, {});
    },
    load(payload, callback) {
      const state = stateFor(payload);
      if (state.page === "root") {
        callback(null, {
          items: [
            { title: "Tracks", subtitle: "2 results", item_key: "tracks", hint: "list" }
          ]
        });
        return;
      }
      if (state.page === "tracks") {
        if (/^kamilo sanclemente no regrets$/i.test(state.query)) {
          callback(null, {
            items: [
              {
                title: "No Regrets (feat. Norman Brown)",
                subtitle: "Phylicia Rae, Norman Brown, Jacob Webb",
                item_key: "wrong-no-regrets",
                hint: "audio"
              }
            ]
          });
          return;
        }
        if (/^no regrets kamilo sanclemente$/i.test(state.query)) {
          callback(null, {
            items: [
              {
                title: "No Regrets",
                subtitle: "Kamilo Sanclemente - Parallel Moon",
                item_key: "exact-no-regrets",
                hint: "audio"
              }
            ]
          });
          return;
        }
      }
      if (state.page === "actions") {
        callback(null, {
          items: [
            { title: "Add To Queue", subtitle: "", item_key: "queue-action", hint: "action" }
          ]
        });
        return;
      }
      callback(null, { items: [] });
    }
  };

  const result = await roon.resolveSearchAction({
    artist: "Kamilo Sanclemente",
    title: "No Regrets",
    album: "Parallel Moon",
    year: 2026
  }, "zone-1", "queue");

  assert.equal(result.success, true);
  assert.equal(result.query, "No Regrets Kamilo Sanclemente");
  assert.equal(result.match.title, "No Regrets");
  assert.equal(result.action, "Add To Queue");
  assert.deepEqual(inputs.slice(0, 2), [
    "Kamilo Sanclemente No Regrets",
    "No Regrets Kamilo Sanclemente"
  ]);
});

test("Roon queue resolver drills into matching release when track search has title collision", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1" });
  const sessions = new Map();

  function stateFor(payload) {
    const session = payload.multi_session_key;
    const state = sessions.get(session) || {};
    sessions.set(session, state);
    return state;
  }

  roon.browse = {
    browse(payload, callback) {
      const state = stateFor(payload);
      if (payload.input) {
        state.query = payload.input;
        state.page = "root";
      } else if (payload.item_key === "tracks") {
        state.page = "tracks";
      } else if (payload.item_key === "albums") {
        state.page = "albums";
      } else if (payload.item_key === "album-hypercube") {
        state.page = "album-hypercube";
      } else if (payload.item_key === "track-hypercube") {
        state.page = "actions";
      } else if (payload.item_key === "queue-action") {
        state.page = "queued";
      }
      callback(null, {});
    },
    load(payload, callback) {
      const state = stateFor(payload);
      if (state.page === "root") {
        callback(null, {
          items: [
            { title: "Tracks", subtitle: "2 results", item_key: "tracks", hint: "list" },
            { title: "Albums", subtitle: "2 results", item_key: "albums", hint: "list" }
          ]
        });
        return;
      }
      if (state.page === "tracks") {
        callback(null, {
          items: [
            {
              title: "Hypercube",
              subtitle: "Nathan Fake",
              item_key: "wrong-hypercube",
              hint: "audio"
            }
          ]
        });
        return;
      }
      if (state.page === "albums") {
        callback(null, {
          items: [
            {
              title: "Hypercube",
              subtitle: "Nathan Fake",
              item_key: "wrong-album",
              hint: "album"
            },
            {
              title: "Hypercube",
              subtitle: "Max Graham / Second Sine / Ruben Karapetyan",
              item_key: "album-hypercube",
              hint: "album"
            }
          ]
        });
        return;
      }
      if (state.page === "album-hypercube") {
        callback(null, {
          items: [
            {
              title: "Hypercube",
              subtitle: "7:30",
              item_key: "track-hypercube",
              hint: "audio"
            },
            {
              title: "Hypercube (Ruben Karapetyan Remix)",
              subtitle: "7:56",
              item_key: "track-hypercube-remix",
              hint: "audio"
            }
          ]
        });
        return;
      }
      if (state.page === "actions") {
        callback(null, {
          items: [
            { title: "Add To Queue", subtitle: "", item_key: "queue-action", hint: "action" }
          ]
        });
        return;
      }
      callback(null, { items: [] });
    }
  };

  const result = await roon.resolveSearchAction({
    artist: "Max Graham, Second Sine",
    title: "Hypercube"
  }, "zone-1", "queue");

  assert.equal(result.success, true);
  assert.equal(result.match.item_key, "track-hypercube");
  assert.equal(result.nestedMatch.container.key, "album-hypercube");
  assert.equal(result.action, "Add To Queue");
});

test("Roon queue resolver does not infer a remix version solely from artist credits", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1" });
  const sessions = new Map();

  function stateFor(payload) {
    const session = payload.multi_session_key;
    const state = sessions.get(session) || {};
    sessions.set(session, state);
    return state;
  }

  roon.browse = {
    browse(payload, callback) {
      const state = stateFor(payload);
      if (payload.input) {
        state.page = "root";
      } else if (payload.item_key === "tracks") {
        state.page = "tracks";
      } else if (payload.item_key === "track-ouverture-khen") {
        state.page = "actions";
      } else if (payload.item_key === "queue-action") {
        state.page = "queued";
      }
      callback(null, {});
    },
    load(payload, callback) {
      const state = stateFor(payload);
      if (state.page === "root") {
        callback(null, {
          items: [
            { title: "Tracks", subtitle: "2 results", item_key: "tracks", hint: "list" }
          ]
        });
        return;
      }
      if (state.page === "tracks") {
        callback(null, {
          items: [
            {
              title: "Ouverture",
              subtitle: "Thomas Bangalter, Guy-Manuel de Homem-Christo, Daft Punk",
              item_key: "wrong-ouverture",
              hint: "audio"
            },
            {
              title: "Ouverture (Khen Remix)",
              subtitle: "Amand / Capoon / khen",
              item_key: "track-ouverture-khen",
              hint: "audio"
            }
          ]
        });
        return;
      }
      if (state.page === "actions") {
        callback(null, {
          items: [
            { title: "Add To Queue", subtitle: "", item_key: "queue-action", hint: "action" }
          ]
        });
        return;
      }
      callback(null, { items: [] });
    }
  };

  const result = await roon.resolveSearchAction({
    artist: "Amand, Capoon, khen",
    title: "Ouverture"
  }, "zone-1", "queue");

  assert.equal(result.success, false);
  assert.equal(result.match.item_key, "track-ouverture-khen");
  assert.equal(result.playable, undefined);
});

test("Roon queue resolver accepts exact remix title from Various Artists compilation", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1" });
  const sessions = new Map();

  function stateFor(payload) {
    const session = payload.multi_session_key;
    const state = sessions.get(session) || {};
    sessions.set(session, state);
    return state;
  }

  roon.browse = {
    browse(payload, callback) {
      const state = stateFor(payload);
      if (payload.input) {
        state.page = "root";
      } else if (payload.item_key === "tracks") {
        state.page = "tracks";
      } else if (payload.item_key === "track-irrev") {
        state.page = "actions";
      } else if (payload.item_key === "queue-action") {
        state.page = "queued";
      }
      callback(null, {});
    },
    load(payload, callback) {
      const state = stateFor(payload);
      if (state.page === "root") {
        callback(null, {
          items: [
            { title: "Tracks", subtitle: "1 result", item_key: "tracks", hint: "list" }
          ]
        });
        return;
      }
      if (state.page === "tracks") {
        callback(null, {
          items: [
            {
              title: "Irreversible (Hobin Rude Remix)",
              subtitle: "Various Artists",
              item_key: "track-irrev",
              hint: "audio"
            }
          ]
        });
        return;
      }
      if (state.page === "actions") {
        callback(null, {
          items: [
            { title: "Add To Queue", subtitle: "", item_key: "queue-action", hint: "action" }
          ]
        });
        return;
      }
      callback(null, { items: [] });
    }
  };

  const result = await roon.resolveSearchAction({
    artist: "AKIVA",
    title: "Irreversible (Hobin Rude Remix)"
  }, "zone-1", "queue");

  assert.equal(result.success, true);
  assert.equal(result.match.item_key, "track-irrev");
  assert.equal(result.action, "Add To Queue");
});

test("Roon queue resolver drills exact title row when queue action is nested one level deeper", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1" });
  const sessions = new Map();

  function stateFor(payload) {
    const session = payload.multi_session_key;
    const state = sessions.get(session) || {};
    sessions.set(session, state);
    return state;
  }

  roon.browse = {
    browse(payload, callback) {
      const state = stateFor(payload);
      if (payload.input) {
        state.page = "root";
      } else if (payload.item_key === "tracks") {
        state.page = "tracks";
      } else if (payload.item_key === "track-jailbreak") {
        state.page = "track-page";
      } else if (payload.item_key === "nested-jailbreak") {
        state.page = "actions";
      } else if (payload.item_key === "queue-action") {
        state.page = "queued";
      }
      callback(null, {});
    },
    load(payload, callback) {
      const state = stateFor(payload);
      if (state.page === "root") {
        callback(null, {
          items: [
            { title: "Tracks", subtitle: "1 result", item_key: "tracks", hint: "list" }
          ]
        });
        return;
      }
      if (state.page === "tracks") {
        callback(null, {
          items: [
            {
              title: "Jailbreak (Radio Mix)",
              subtitle: "Beckers, D-Nox",
              item_key: "track-jailbreak",
              hint: "audio"
            }
          ]
        });
        return;
      }
      if (state.page === "track-page") {
        callback(null, {
          items: [
            {
              title: "Jailbreak (Radio Mix)",
              subtitle: "",
              item_key: "nested-jailbreak",
              hint: "audio"
            }
          ]
        });
        return;
      }
      if (state.page === "actions") {
        callback(null, {
          items: [
            { title: "Add To Queue", subtitle: "", item_key: "queue-action", hint: "action" }
          ]
        });
        return;
      }
      callback(null, { items: [] });
    }
  };

  const result = await roon.resolveSearchAction({
    artist: "Beckers, D-Nox",
    title: "Jailbreak (Radio Mix)"
  }, "zone-1", "queue");

  assert.equal(result.success, true);
  assert.equal(result.match.item_key, "track-jailbreak");
  assert.equal(result.action, "Add To Queue");
});

test("Roon queue resolver rejects a named remix when plain title has no exact hit", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1" });
  const sessions = new Map();

  function stateFor(payload) {
    const session = payload.multi_session_key;
    const state = sessions.get(session) || {};
    sessions.set(session, state);
    return state;
  }

  roon.browse = {
    browse(payload, callback) {
      const state = stateFor(payload);
      if (payload.input) {
        state.page = "root";
      } else if (payload.item_key === "tracks") {
        state.page = "tracks";
      } else if (payload.item_key === "track-neuro-remix") {
        state.page = "actions";
      } else if (payload.item_key === "queue-action") {
        state.page = "queued";
      }
      callback(null, {});
    },
    load(payload, callback) {
      const state = stateFor(payload);
      if (state.page === "root") {
        callback(null, {
          items: [
            { title: "Tracks", subtitle: "1 result", item_key: "tracks", hint: "list" }
          ]
        });
        return;
      }
      if (state.page === "tracks") {
        callback(null, {
          items: [
            {
              title: "Neurotransmitter (Gai Barone Remix)",
              subtitle: "Ruben Karapetyan",
              item_key: "track-neuro-remix",
              hint: "audio"
            }
          ]
        });
        return;
      }
      if (state.page === "actions") {
        callback(null, {
          items: [
            { title: "Add To Queue", subtitle: "", item_key: "queue-action", hint: "action" }
          ]
        });
        return;
      }
      callback(null, { items: [] });
    }
  };

  const result = await roon.resolveSearchAction({
    artist: "Ruben Karapetyan",
    title: "Neurotransmitter"
  }, "zone-1", "queue");

  assert.equal(result.success, false);
  assert.equal(result.match.item_key, "track-neuro-remix");
  assert.equal(result.playable, undefined);
});

test("Roon queue resolver uses matching remixes release when track artist differs", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1" });
  const sessions = new Map();

  function stateFor(payload) {
    const session = payload.multi_session_key;
    const state = sessions.get(session) || {};
    sessions.set(session, state);
    return state;
  }

  roon.browse = {
    browse(payload, callback) {
      const state = stateFor(payload);
      if (payload.input) {
        state.page = "root";
      } else if (payload.item_key === "tracks") {
        state.page = "tracks";
      } else if (payload.item_key === "albums") {
        state.page = "albums";
      } else if (payload.item_key === "album-dreaming-home") {
        state.page = "album-dreaming-home";
      } else if (payload.item_key === "track-dreaming-home") {
        state.page = "actions";
      } else if (payload.item_key === "queue-action") {
        state.page = "queued";
      }
      callback(null, {});
    },
    load(payload, callback) {
      const state = stateFor(payload);
      if (state.page === "root") {
        callback(null, {
          items: [
            { title: "Tracks", subtitle: "5 results", item_key: "tracks", hint: "list" },
            { title: "Albums", subtitle: "1 result", item_key: "albums", hint: "list" }
          ]
        });
        return;
      }
      if (state.page === "tracks") {
        callback(null, {
          items: [
            {
              title: "Dreaming Home (Sebastian Sellares Remix)",
              subtitle: "Ric Niels / Hobin Rude / Manu Pavez",
              item_key: "wrong-artist-track",
              hint: "audio"
            }
          ]
        });
        return;
      }
      if (state.page === "albums") {
        callback(null, {
          items: [
            {
              title: "Dreaming Home (Remixes)",
              subtitle: "Eric Lune, Sebastian Sellares, Forty Cats",
              item_key: "album-dreaming-home",
              hint: "album"
            }
          ]
        });
        return;
      }
      if (state.page === "album-dreaming-home") {
        callback(null, {
          items: [
            {
              title: "Dreaming Home (Sebastian Sellares Remix)",
              subtitle: "7:36",
              item_key: "track-dreaming-home",
              hint: "audio"
            }
          ]
        });
        return;
      }
      if (state.page === "actions") {
        callback(null, {
          items: [
            { title: "Add To Queue", subtitle: "", item_key: "queue-action", hint: "action" }
          ]
        });
        return;
      }
      callback(null, { items: [] });
    }
  };

  const result = await roon.resolveSearchAction({
    artist: "Eric Lune",
    title: "Dreaming Home (Sebastian Sellares Remix)"
  }, "zone-1", "queue");

  assert.equal(result.success, true);
  assert.equal(result.match.item_key, "track-dreaming-home");
  assert.equal(result.nestedMatch.container.key, "album-dreaming-home");
  assert.equal(result.action, "Add To Queue");
});

test("Roon queue resolver prefers extended mix when requested", async () => {
  const roon = new RoonClient();
  roon.transport = {};
  roon.zones.set("zone-1", { zone_id: "zone-1" });
  const sessions = new Map();
  const inputs = [];

  function stateFor(payload) {
    const session = payload.multi_session_key;
    const state = sessions.get(session) || {};
    sessions.set(session, state);
    return state;
  }

  roon.browse = {
    browse(payload, callback) {
      const state = stateFor(payload);
      if (payload.input) {
        inputs.push(payload.input);
        state.page = "root";
      } else if (payload.item_key === "tracks") {
        state.page = "tracks";
      } else if (payload.item_key === "track-peace" || payload.item_key === "track-peace-extended") {
        state.page = "actions";
        state.selected = payload.item_key;
      } else if (payload.item_key === "queue-action") {
        state.page = "queued";
      }
      callback(null, {});
    },
    load(payload, callback) {
      const state = stateFor(payload);
      if (state.page === "root") {
        callback(null, {
          items: [
            { title: "Tracks", subtitle: "2 results", item_key: "tracks", hint: "list" }
          ]
        });
        return;
      }
      if (state.page === "tracks") {
        callback(null, {
          items: [
            {
              title: "Peace",
              subtitle: "D-Nox, Elan Myles - Peace",
              item_key: "track-peace",
              hint: "audio"
            },
            {
              title: "Peace (Extended Mix)",
              subtitle: "D-Nox, Elan Myles - Peace",
              item_key: "track-peace-extended",
              hint: "audio"
            }
          ]
        });
        return;
      }
      if (state.page === "actions") {
        callback(null, {
          items: [
            { title: "Add To Queue", subtitle: "", item_key: "queue-action", hint: "action" }
          ]
        });
        return;
      }
      callback(null, { items: [] });
    }
  };

  const result = await roon.resolveSearchAction({
    artist: "D-Nox, Elan Myles",
    title: "Peace",
    album: "Peace",
    year: 2025
  }, "zone-1", "queue", { preferExtendedMixes: true });

  assert.equal(result.success, true);
  assert.equal(result.match.item_key, "track-peace-extended");
  assert.equal(result.match.title, "Peace (Extended Mix)");
  assert.equal(result.action, "Add To Queue");
  assert.equal(inputs[0], "D-Nox, Elan Myles Peace extended mix");
});
