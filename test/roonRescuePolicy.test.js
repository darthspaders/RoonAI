"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  roonRescueSceneAnchor,
  scoreWithRoonFloor
} = require("../src/roonRescuePolicy");

test("Roon score floor raises low queueable candidates by existing score caps", () => {
  const result = scoreWithRoonFloor({
    freshness: 20,
    labelMatch: 5,
    artistMatch: 5,
    lengthPreference: 10,
    genreMatch: 10,
    tasteAdjustment: 0,
    total: 50,
    max: {
      genreMatch: 20,
      artistMatch: 15,
      labelMatch: 15
    }
  });

  assert.equal(result.genreMatch, 20);
  assert.equal(result.artistMatch, 15);
  assert.equal(result.labelMatch, 5);
  assert.equal(result.total, 70);
});

test("Roon score floor leaves already strong candidates untouched", () => {
  const breakdown = { total: 75 };
  assert.equal(scoreWithRoonFloor(breakdown), breakdown);
});

test("Roon rescue scene anchor recognizes artist anchors from query", () => {
  assert.equal(roonRescueSceneAnchor({
    query: "Hernan Cattaneo progressive house 2026",
    artist: "Hernan Cattaneo",
    title: "Track"
  }), "Hernan Cattaneo");
});

test("Roon rescue scene anchor can match album anchors and rejects generic anchors", () => {
  assert.equal(roonRescueSceneAnchor({
    query: "Balance Presents progressive house",
    artist: "Various Artists",
    album: "Balance Presents"
  }), "Balance Presents");
  assert.equal(roonRescueSceneAnchor({
    query: "progressive house progressive house",
    artist: "Artist",
    album: "Album"
  }), "");
});
