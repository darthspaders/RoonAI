"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { RoonInternalTidalSync, parseBrokerId } = require("../src/roonInternalTidalSync");

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

test("dispatches the playlist-specific Roon refresh and reports it as unconfirmed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-internal-sync-"));
  const modulePath = path.join(dir, "fake-internal-api.js");
  fs.writeFileSync(modulePath, [
    "module.exports = {",
    "  events: [],",
    "  closed: false,",
    "  RoonClient: class {",
    "    async connect() {}",
    "    serviceOid() { return 715n; }",
    "    close() { module.exports.closed = true; }",
    "  },",
    "  makeApi() { return { tidal: {",
    "    syncPlaylists() { module.exports.events.push('SyncPlaylists'); },",
    "    syncLibrary() { module.exports.events.push('SyncLibrary'); }",
    "  } }; }",
    "};",
  ].join("\n"));

  try {
    const fakeApi = require(modulePath);
    const sync = new RoonInternalTidalSync({
      enabled: true,
      tidalSyncEnabled: true,
      packagePath: modulePath,
      brokerId: "00000000-0000-0000-0000-000000000000",
      dispatchSettleMs: 0
    }, { info() {}, warn() {} });

    const result = await sync.syncPlaylists({ reason: "test" });

    assert.deepEqual(fakeApi.events, ["SyncPlaylists"]);
    assert.equal(fakeApi.closed, true);
    assert.equal(result.success, true);
    assert.equal(result.dispatched, true);
    assert.equal(result.confirmed, false);
    assert.equal(result.operation, "SyncPlaylists");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
