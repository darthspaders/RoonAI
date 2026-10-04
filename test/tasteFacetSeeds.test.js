"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readTasteFacetSeeds } = require("../src/tasteFacetSeeds");

test("taste facet seeds rotate specific library facets instead of returning one global genre", () => {
  const rows = [
    { cluster_key: "metadata:house", cluster_name: "House", member_count: 2000, artist: "Progressive House Artist", label: "House Label", track_count: 20, positive_count: 10, negative_count: 0 },
    { cluster_key: "metadata:bass", cluster_name: "Bass", member_count: 300, artist: "Bass Artist", label: "Wakaan", track_count: 8, positive_count: 4, negative_count: 0 },
    { cluster_key: "metadata:rock", cluster_name: "Rock", member_count: 200, artist: "Rock Artist", label: "Rock Label", track_count: 7, positive_count: 3, negative_count: 0 },
    { cluster_key: "metadata:psytrance", cluster_name: "Psytrance", member_count: 100, artist: "Psy Artist", label: "Psy Label", track_count: 5, positive_count: 2, negative_count: 0 },
    { cluster_key: "metadata:bass", cluster_name: "Bass", member_count: 300, artist: "Bass Artist 2", label: "SubCarbon", track_count: 6, positive_count: 1, negative_count: 0 }
  ];
  const result = readTasteFacetSeeds({ prepare: () => ({ all: () => rows }) }, { maxFacets: 3 });

  assert.equal(result.facets.length, 3);
  assert.ok(result.facets.some(facet => facet.name === "Bass"));
  assert.ok(result.facets.some(facet => facet.name === "Rock"));
  assert.ok(result.artists.includes("Bass Artist"));
  assert.ok(result.artists.includes("Rock Artist"));
  assert.ok(result.labels.includes("Wakaan"));
});

test("taste facet seed failures fail closed", () => {
  assert.deepEqual(readTasteFacetSeeds(null), { facets: [], artists: [], labels: [] });
  assert.deepEqual(readTasteFacetSeeds({ prepare: () => { throw new Error("missing schema"); } }), { facets: [], artists: [], labels: [] });
});
