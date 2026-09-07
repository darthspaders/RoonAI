"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseBrokerId } = require("../src/roonInternalTidalSync");

test("parseBrokerId converts dashed Roon Core UUID to internal GUID byte order", () => {
  assert.equal(
    parseBrokerId("db223379-584b-44f5-89a5-3c44513b07b5").toString("hex"),
    "793322db4b58f54489a53c44513b07b5"
  );
});

test("parseBrokerId accepts explicit 16-byte broker hex unchanged", () => {
  assert.equal(
    parseBrokerId("793322db4b58f54489a53c44513b07b5").toString("hex"),
    "793322db4b58f54489a53c44513b07b5"
  );
});

test("parseBrokerId rejects malformed values", () => {
  assert.throws(() => parseBrokerId("not-a-broker-id"), /ROON_INTERNAL_BROKER_ID/);
});
