"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeTrackLists } = require("../src/trackListMerge");

test("mergeTrackLists dedupes by normalized candidate identity across lists", () => {
  const result = mergeTrackLists(
    [{ artist: "D-SHIFT, Drunken Kong", title: "City Lights (HAFT Remix)" }],
    [{ artist: "D SHIFT / Drunken Kong", title: "City Lights HAFT Remix" }],
    [{ artist: "Other", title: "Track" }]
  );

  assert.equal(result.length, 2);
  assert.equal(result[0].artist, "D-SHIFT, Drunken Kong");
  assert.equal(result[1].artist, "Other");
});

test("mergeTrackLists preserves first item when provider ids collide", () => {
  const result = mergeTrackLists(
    [{ tidal: { id: "123" }, artist: "A", title: "One" }],
    [{ tidalId: "123", artist: "B", title: "Two" }]
  );

  assert.deepEqual(result, [{ tidal: { id: "123" }, artist: "A", title: "One" }]);
});

test("mergeTrackLists keeps fallback artist-title key behavior for sparse tracks", () => {
  const result = mergeTrackLists(
    [{ artist: "A", title: "One" }],
    [{ artist: "A", title: "One" }],
    [{ artist: "A", title: "Two" }]
  );

  assert.deepEqual(result.map((track) => track.title), ["One", "Two"]);
});
