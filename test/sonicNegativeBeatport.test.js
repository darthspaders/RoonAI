"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCentroidReport,
  meanNormalizedVector
} = require("../scripts/sonic-analyze-negative-beatport");

test("negative centroid normalizes the mean without changing dimensions", () => {
  const vector = meanNormalizedVector([[1, 0], [0, 1]]);
  assert.equal(vector.length, 2);
  assert.ok(Math.abs(vector[0] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(vector[1] - Math.SQRT1_2) < 1e-12);
});

test("negative centroid keeps genre groups separate for heterogeneous feedback", () => {
  const report = buildCentroidReport([
    { identityId: 1, identityKey: "text:a|one|", artist: "A", title: "One", genre: "House", embedding: { vector: [1, 0] } },
    { identityId: 2, identityKey: "text:b|two|", artist: "B", title: "Two", genre: "House", embedding: { vector: [1, 0] } },
    { identityId: 3, identityKey: "text:c|three|", artist: "C", title: "Three", genre: "Bass", embedding: { vector: [0, 1] } }
  ], "discogs-effnet", "1");
  assert.equal(report.count, 3);
  assert.equal(report.dimensions, 2);
  assert.equal(report.groups.length, 2);
  assert.deepEqual(report.groups.map((group) => [group.key, group.count]), [["House", 2], ["Bass", 1]]);
  assert.deepEqual(report.groups[0].vector, [1, 0]);
});
