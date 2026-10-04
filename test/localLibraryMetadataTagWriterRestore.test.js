"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { formatPolicy, buildFfmpegWriteArgs, probeTags, tagMatches } = require("../src/localLibraryMetadataTagWriter");

test("tag writer policies remain explicit for the staged formats", () => {
  assert.equal(formatPolicy("song.flac").status, "supported");
  assert.equal(formatPolicy("song.dsf").status, "supported");
  assert.equal(formatPolicy("song.dsf").writer, "dsf-id3");
  assert.ok(buildFfmpegWriteArgs("song.flac", "song.tmp.flac", [{ tag: "LABEL", value: "Example" }]).includes("LABEL=Example"));
});

test("restore validation uses the same normalized tag view", () => {
  const probe = { format: { tags: { LABEL: "Example" } }, streams: [] };
  assert.equal(probeTags(probe).label, "Example");
  assert.equal(tagMatches(probe, { tag: "label", value: "Example" }), true);
});
