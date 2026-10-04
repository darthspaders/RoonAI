"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RabbitHoleGraph } = require("../src/rabbitHoleGraph");

function tempCacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-graph-"));
  return path.join(dir, "rabbit-hole-cache.json");
}

test("graph seed enrichment rejects same-title wrong-artist catalog verification", async () => {
  const graphStore = new RabbitHoleGraph({ file: tempCacheFile() });
  const fakeTidal = {
    isConfigured: () => true,
    verify: async () => ({
      artist: "Akon",
      title: "Lonely",
      album: "Trouble",
      label: "Universal Records",
      year: 2004,
      tidalUrl: "https://tidal.com/browse/track/1"
    }),
    getArtistAlbums: async () => []
  };

  const graph = await graphStore.build({
    artist: "Abity",
    title: "Lonely (Original Mix)",
    discoverySource: "Now playing"
  }, {
    tidal: fakeTidal,
    config: { rabbitHole: { musicBrainz: false } }
  }, { force: true });

  assert.equal(graph.seed.artist, "Abity");
  assert.equal(graph.seed.title, "Lonely (Original Mix)");
  assert.notEqual(graph.seed.album, "Trouble");
  assert.equal(graph.seed.tidalUrl, "");
});

test("legacy graph cache entries are ignored after metadata verification tightening", () => {
  const file = tempCacheFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    entries: [{
      key: "abity|lonely",
      updatedAtMs: Date.now(),
      graph: {
        seed: {
          artist: "Akon",
          title: "Lonely"
        }
      }
    }]
  }));

  const graphStore = new RabbitHoleGraph({ file });
  assert.equal(graphStore.cached({ artist: "Abity", title: "Lonely" }), null);
});

test("similar artist expansion uses Last.fm artist similarity as controlled crawl seeds", async () => {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /method=artist\.getsimilar/);
    return {
      ok: true,
      json: async () => ({
        similarartists: {
          artist: [
            { name: "Related One", match: "0.98" },
            { name: "Related Two", match: "0.82" },
            { name: "Seed Artist", match: "0.7" }
          ]
        }
      })
    };
  };

  try {
    const graphStore = new RabbitHoleGraph({ file: tempCacheFile() });
    const artists = await graphStore.similarArtistsForSeeds(["Seed Artist"], {
      config: { rabbitHole: { lastfmApiKey: "test-key", musicBrainz: false } }
    }, {
      seedLimit: 1,
      perSeed: 3,
      limit: 3
    });

    assert.deepEqual(artists.map((artist) => artist.name), ["Related One", "Related Two"]);
    assert.equal(artists[0].source, "Last.fm similar");
    assert.equal(artists[0].matchScore, 0.98);
  } finally {
    global.fetch = previousFetch;
  }
});

test("similar artist expansion skips an external seed whose Last.fm identity conflicts with its learned facet", async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed.searchParams.get("method"));
    if (parsed.searchParams.get("method") === "artist.getinfo") {
      return {
        ok: true,
        json: async () => ({ artist: { tags: { tag: [{ name: "classical" }, { name: "renaissance" }, { name: "trance" }] } } })
      };
    }
    return {
      ok: true,
      json: async () => ({ similarartists: { artist: [{ name: "Wrong Branch", match: "0.99" }] } })
    };
  };

  try {
    const graphStore = new RabbitHoleGraph({ file: tempCacheFile() });
    const artists = await graphStore.similarArtistsForSeeds(["John Johnson"], {
      config: { rabbitHole: { lastfmApiKey: "test-key" } }
    }, {
      seedLimit: 1,
      perSeed: 3,
      limit: 3,
      validateSeedContext: true,
      seedContexts: { "john johnson": "Progressive House" }
    });

    assert.equal(artists.length, 0);
    assert.deepEqual(calls, ["artist.getinfo"]);
    assert.equal(artists.seedValidation[0].artist, "John Johnson");
    assert.equal(artists.seedValidation[0].accepted, false);
  } finally {
    global.fetch = previousFetch;
  }
});
