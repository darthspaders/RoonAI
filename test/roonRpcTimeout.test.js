"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RoonClient } = require("../src/roonClient");
const { createLyrionApi } = require("../src/lyrionApi");

function silentRoon() {
  const client = new RoonClient();
  client.transport = { control() {}, play_from_here() {} };
  client.zones.set("zone-1", { zone_id: "zone-1", display_name: "WiiM Pro BR", outputs: [{ output_id: "output-1" }] });
  client.queues.set("zone-1", { items: [{ id: 42, title: "Queued track" }] });
  return client;
}

async function settlesAfter(t, promise, ms) {
  let outcome = "pending";
  promise.then(() => { outcome = "resolved"; }, (error) => { outcome = error; });
  t.mock.timers.tick(ms - 1);
  await new Promise(setImmediate);
  const before = outcome;
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  return { before, after: outcome };
}

test("a Roon transport call that never answers fails after 15 seconds instead of waiting forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { before, after } = await settlesAfter(t, silentRoon().control("zone-1", "pause"), 15000);
  assert.equal(before, "pending");
  assert.equal(after.code, "ETIMEDOUT");
  assert.match(after.message, /Roon did not answer within 15 seconds/);
});

test("Play from here that never answers also fails after 15 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { before, after } = await settlesAfter(t, silentRoon().playFromHere("zone-1", "42"), 15000);
  assert.equal(before, "pending");
  assert.equal(after.code, "ETIMEDOUT");
});

test("a Roon reply that arrives in time still resolves, and its timer is cleared", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = silentRoon();
  client.transport.control = (target, control, callback) => callback(false, { ok: control });
  assert.deepEqual(await client.control("zone-1", "pause"), { ok: "pause" });
  t.mock.timers.tick(15000);
});

test("Lyrion play reports the Roon zone that would not pause, and the next Lyrion action still runs", async () => {
  const calls = [];
  let body = { action: "play", playerId: "p" };
  const sent = [];
  const roon = {
    getState: () => ({ zones: [{ zone_id: "zone-1", display_name: "WiiM Pro BR", state: "playing" }] }),
    control: async () => { throw Object.assign(new Error("Roon did not answer within 15 seconds."), { code: "ETIMEDOUT" }); }
  };
  const client = { requirePlayer: async () => {}, control: async (...args) => { calls.push(args); return {}; }, players: async () => [] };
  const api = createLyrionApi({ roon, client, file: "does-not-exist", readJson: async () => body, sendJson: (res, status, payload) => sent.push([status, payload]) });
  const req = { method: "POST", headers: {} };
  const url = new URL("http://localhost:3777/api/lyrion/control");

  await assert.rejects(api.handle(req, {}, url), /Could not pause Roon zone "WiiM Pro BR" before playing on Lyrion: Roon did not answer within 15 seconds\./);
  assert.deepEqual(calls, []);

  body = { action: "pause", playerId: "p" };
  await api.handle(req, {}, url);
  assert.deepEqual(calls, [["p", "pause"]]);
  assert.deepEqual(sent, [[200, { ok: true, result: {} }]]);
});
