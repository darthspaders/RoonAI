"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  RadioMetadataResolver,
  chooseTidalTrack
} = require("../src/radioMetadataResolver");

const COVER_UUID = "12345678-abcd-4321-9000-123456789abc";

test("artist-qualified radio lookup does not create title-only catalog searches", () => {
  const resolver = new RadioMetadataResolver();
  const queries = resolver.createSearchQueries({
    artist: "Abity",
    title: "Lonely (Original Mix)"
  });

  assert.equal(queries.includes("Lonely (Original Mix)"), false);
  assert.equal(queries.includes("Lonely"), false);
  assert.ok(queries.some((query) => /abity/i.test(query)));
});

test("TIDAL candidate selection rejects same-title wrong-artist radio artwork", () => {
  const searchJson = {
    tracks: {
      items: [{
        id: "1",
        title: "Lonely",
        duration: 240,
        artists: [{ name: "Akon" }],
        album: {
          title: "Trouble",
          cover: COVER_UUID
        }
      }]
    }
  };

  assert.equal(chooseTidalTrack(searchJson, {
    artist: "Abity",
    title: "Lonely (Original Mix)"
  }), null);

  const matched = chooseTidalTrack(searchJson, {
    artist: "Akon",
    title: "Lonely"
  });
  assert.equal(matched.album, "Trouble");
});

test("TIDAL web scraping is skipped when radio lookup has an artist", async () => {
  let fetched = false;
  const resolver = new RadioMetadataResolver({
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, text: async () => "" };
    }
  });

  const result = await resolver.searchTidalWeb({
    artist: "Abity",
    title: "Lonely (Original Mix)"
  }, "abity|lonely");

  assert.equal(result, null);
  assert.equal(fetched, false);
});

test("radio metadata TIDAL circuit opens after fetch failures", async () => {
  let calls = 0;
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "token",
    tidalFailureThreshold: 1,
    tidalCircuitCooldownMs: 1000,
    fetchJson: async () => {
      calls += 1;
      const error = new Error("TIDAL API lookup timed out after 1s");
      error.code = "ETIMEDOUT";
      throw error;
    }
  });

  await assert.rejects(
    () => resolver.fetchTidalSearchJson("https://openapi.tidal.com/v2/searchResults/test/relationships/tracks"),
    /timed out/
  );
  assert.equal(resolver.status().tidalCircuit.state, "open");

  await assert.rejects(
    () => resolver.fetchTidalSearchJson("https://openapi.tidal.com/v2/searchResults/test-2/relationships/tracks"),
    /temporarily unavailable/
  );
  assert.equal(calls, 1);
});
