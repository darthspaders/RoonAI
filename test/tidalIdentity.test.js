"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  explicitTidalTrackId,
  normalizeTidalTrackUrl,
  tidalTrackIdFromUrl
} = require("../src/tidalIdentity");

test("tidal identity extracts numeric track ids from TIDAL URLs", () => {
  assert.equal(tidalTrackIdFromUrl("https://tidal.com/browse/track/544016594"), "544016594");
  assert.equal(tidalTrackIdFromUrl("https://listen.tidal.com/track/12345"), "12345");
  assert.equal(tidalTrackIdFromUrl("https://tidal.com/browse/album/12345"), "");
  assert.equal(tidalTrackIdFromUrl("https://tidal.com/browse/track/current-track"), "");
});

test("tidal identity finds explicit numeric track ids in common backend shapes", () => {
  assert.equal(explicitTidalTrackId({ tidal: { id: "101" } }), "101");
  assert.equal(explicitTidalTrackId({ tidal: { trackId: "102" } }), "102");
  assert.equal(explicitTidalTrackId({ tidal: { track_id: "103" } }), "103");
  assert.equal(explicitTidalTrackId({ tidalId: "104" }), "104");
  assert.equal(explicitTidalTrackId({ tidalTrackId: "105" }), "105");
  assert.equal(explicitTidalTrackId({ id: "106" }), "106");
  assert.equal(explicitTidalTrackId({ trackId: "107" }), "107");
  assert.equal(explicitTidalTrackId({ id: "current-track" }), "");
});

test("tidal identity normalizes supported TIDAL track URLs without broadening placeholders", () => {
  assert.equal(
    normalizeTidalTrackUrl("https://listen.tidal.com/track/544016594?u"),
    "https://tidal.com/browse/track/544016594"
  );
  assert.equal(
    normalizeTidalTrackUrl("https://www.tidal.com/browse/track/12345"),
    "https://tidal.com/browse/track/12345"
  );
  assert.equal(
    normalizeTidalTrackUrl("https://tidal.com/browse/track/current-track"),
    "https://tidal.com/browse/track/current-track"
  );
  assert.equal(normalizeTidalTrackUrl("https://example.com/track/123"), "https://example.com/track/123");
});
