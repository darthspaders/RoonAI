"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  albumDiversityKey,
  artistDiversityKey,
  diversifyCandidates,
  requestAllowsArtistCluster,
  trackDiversityKey
} = require("../src/discoveryDiversity");

test("artist cluster request detection keeps deep-dive wording behavior", () => {
  assert.equal(requestAllowsArtistCluster({ request: "give me an artist deep dive on Khen" }), true);
  assert.equal(requestAllowsArtistCluster({ reference: "more from Sasha" }), true);
  assert.equal(requestAllowsArtistCluster({ request: "progressive house from 2019" }), false);
});

test("diversity keys use normalized artist, album, and candidate identity", () => {
  const track = {
    artist: "D-SHIFT, Drunken Kong",
    album: "City Lights EP",
    title: "City Lights (HAFT Remix)"
  };

  assert.equal(artistDiversityKey(track), "d shift");
  assert.equal(albumDiversityKey(track), "city lights ep");
  assert.equal(trackDiversityKey(track), "d shift drunken kong|city lights haft remix");
});

test("diversifyCandidates preserves artist caps before filling relaxed remainder", () => {
  const candidates = [
    { artist: "A", album: "one", title: "a1" },
    { artist: "A", album: "two", title: "a2" },
    { artist: "B", album: "three", title: "b1" },
    { artist: "C", album: "four", title: "c1" }
  ];

  const result = diversifyCandidates(candidates, 3, {});

  assert.deepEqual(result.tracks.map((track) => track.title), ["a1", "b1", "c1"]);
  assert.equal(result.artistSpread, 3);
  assert.equal(result.albumSpread, 3);
  assert.equal(result.relaxed, false);
});

test("diversifyCandidates allows same-artist clusters for explicit catalog requests", () => {
  const candidates = [
    { artist: "A", album: "one", title: "a1" },
    { artist: "A", album: "two", title: "a2" },
    { artist: "A", album: "three", title: "a3" }
  ];

  const result = diversifyCandidates(candidates, 3, { request: "more from A" });

  assert.deepEqual(result.tracks.map((track) => track.title), ["a1", "a2", "a3"]);
  assert.equal(result.artistSpread, 1);
  assert.equal(result.albumSpread, 3);
});

test("diversifyCandidates suppresses duplicate track identities", () => {
  const candidates = [
    { artist: "A", title: "Same" },
    { artist: "A", title: "Same" },
    { artist: "B", title: "Other" }
  ];

  const result = diversifyCandidates(candidates, 3, {});

  assert.deepEqual(result.tracks.map((track) => `${track.artist}:${track.title}`), ["A:Same", "B:Other"]);
  assert.equal(result.alternates.length, 0);
  assert.equal(result.relaxed, true);
});
