"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TidalPinnedMixStore,
  parseTidalPinnedInput,
  tidalPinnedUrl
} = require("../src/tidalPinnedMixes");

function tempPinnedFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tidal-pinned-mixes-"));
  return path.join(dir, "pinned.json");
}

test("pinned TIDAL parser accepts mix, playlist, and artist radio links", () => {
  assert.deepEqual(parseTidalPinnedInput("https://listen.tidal.com/mix/mix-123?u"), {
    kind: "mix",
    id: "mix-123",
    sourceUrl: "https://listen.tidal.com/mix/mix-123?u"
  });
  assert.deepEqual(parseTidalPinnedInput("https://tidal.com/browse/playlist/playlist_456"), {
    kind: "playlist",
    id: "playlist_456",
    sourceUrl: "https://tidal.com/browse/playlist/playlist_456"
  });
  assert.deepEqual(parseTidalPinnedInput("https://tidal.com/browse/artist/747/radio"), {
    kind: "artist-radio",
    id: "747",
    sourceUrl: "https://tidal.com/browse/artist/747/radio"
  });
  assert.deepEqual(parseTidalPinnedInput("tidal://artist/747/radio"), {
    kind: "artist-radio",
    id: "747",
    sourceUrl: "tidal://artist/747/radio"
  });
});

test("pinned TIDAL parser accepts shorthand and direct playlist ids", () => {
  assert.deepEqual(parseTidalPinnedInput("artist-radio:747"), {
    kind: "artist-radio",
    id: "747",
    sourceUrl: "artist-radio:747"
  });
  assert.deepEqual(parseTidalPinnedInput("mix:daily-abc"), {
    kind: "mix",
    id: "daily-abc",
    sourceUrl: "mix:daily-abc"
  });
  assert.deepEqual(parseTidalPinnedInput("abcdef12345"), {
    kind: "playlist",
    id: "abcdef12345",
    sourceUrl: "abcdef12345"
  });
});

test("pinned TIDAL store dedupes, persists, and removes items", () => {
  const file = tempPinnedFile();
  const store = new TidalPinnedMixStore({ file });

  const first = store.add("https://listen.tidal.com/mix/mix-1");
  assert.equal(first.added, true);
  assert.equal(first.items.length, 1);
  assert.equal(first.item.key, "mix:mix-1");

  const duplicate = store.add("https://tidal.com/browse/mix/mix-1");
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.items.length, 1);
  assert.equal(duplicate.items[0].sourceUrl, "https://tidal.com/browse/mix/mix-1");

  const reloaded = new TidalPinnedMixStore({ file });
  assert.deepEqual(reloaded.list().map((item) => item.key), ["mix:mix-1"]);

  const removed = reloaded.remove("mix:mix-1");
  assert.equal(removed.removed, true);
  assert.equal(removed.items.length, 0);
});

test("pinned TIDAL url helper builds browse links for stored items", () => {
  assert.equal(tidalPinnedUrl("artist-radio", "747"), "https://tidal.com/browse/artist/747/radio");
  assert.equal(tidalPinnedUrl("mix", "mix-1"), "https://listen.tidal.com/mix/mix-1");
  assert.equal(tidalPinnedUrl("playlist", "playlist-1"), "https://listen.tidal.com/playlist/playlist-1");
});
