"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RoonClient } = require("../src/roonClient");

test("Roon heartbeat keeps node-roon-api's native transport timer", () => {
  const client = new RoonClient();
  const builtInTimer = setInterval(() => {}, 60000);
  const ws = { readyState: 1, ping() {} };
  const transport = { interval: builtInTimer, ws };
  const core = { moo: { transport } };
  client.startHeartbeat(core);

  assert.equal(transport.interval, builtInTimer);
  assert.equal(client.heartbeatTransport, transport);
  assert.equal(client.heartbeatWs, ws);
  assert.equal(client.heartbeatTimer, null);

  client.stopHeartbeat();
  clearInterval(builtInTimer);
  assert.equal(client.heartbeatTimer, null);
  assert.equal(client.heartbeatTransport, null);
  assert.equal(client.heartbeatWs, null);
});

test("Roon disconnect keeps the last zone snapshot while reconnecting", () => {
  const client = new RoonClient();
  client.zones.set("zone-1", {
    zone_id: "zone-1",
    display_name: "HQPlayer",
    state: "playing",
    now_playing: { one_line: { line1: "Test Track" } }
  });
  client.queues.set("zone-1", { items: [{ queue_item_id: 1, length: 180 }] });
  client.queueSubscriptions.add("zone-1");
  client.queueSignatures.set("zone-1", "signature");

  client.handleUnpaired({ core_id: "core-1" });

  const state = client.getState();
  assert.equal(state.connected, false);
  assert.equal(state.connectionDiagnostics.state, "unpaired");
  assert.equal(state.zones.length, 1);
  assert.equal(state.zones[0].now_playing.one_line.line1, "Test Track");
  assert.equal(state.zones[0].queue.items.length, 1);
  assert.equal(client.queueSubscriptions.size, 0);
  assert.equal(client.queueSignatures.size, 0);
});

test("stale Roon unpair callbacks cannot clear a newer paired session", () => {
  const client = new RoonClient();
  const activeCore = { core_id: "core-1" };
  const staleCore = { core_id: "core-1" };
  const activeTransport = {};
  const activeBrowse = {};
  client.core = activeCore;
  client.transport = activeTransport;
  client.browse = activeBrowse;
  client.connectionDiagnostics.state = "paired";
  client.connectionDiagnostics.connectionSequence = 2;

  client.handleUnpaired(staleCore);

  assert.equal(client.core, activeCore);
  assert.equal(client.transport, activeTransport);
  assert.equal(client.browse, activeBrowse);
  assert.equal(client.connectionDiagnostics.state, "paired");
  assert.equal(client.connectionDiagnostics.unpairedCount, 0);
  assert.equal(client.connectionDiagnostics.staleUnpairedCount, 1);
});
