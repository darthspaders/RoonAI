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
