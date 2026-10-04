"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once, EventEmitter } = require("node:events");
const WebSocket = require("ws");
const { attachSoundSpectrumVideo, packet } = require("../src/soundSpectrumVideo");
const VIEWER = "viewer_12345678901234567890";
const frame = value => Buffer.from([0xff, 0xd8, value, 0xff, 0xd9]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const events = new EventEmitter(); let valid = true;
  const service = { authorizeVideo(id) { if (!valid || id !== VIEWER) throw Error("expired"); return {}; }, onVideo(listener) { events.on("video", listener); return () => events.off("video", listener); } };
  const server = http.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = attachSoundSpectrumVideo(server, { service, requestOrigin: () => origin });
  t.after(async () => { transport.close(); await new Promise(resolve => server.close(resolve)); });
  async function connect(headers = { Origin: origin }, viewerId = VIEWER) {
    const ws = new WebSocket(origin.replace("http:", "ws:") + "/api/soundspectrum/frames?viewerId=" + viewerId, { headers });
    ws.on("error", () => {}); await once(ws, "open"); t.after(() => ws.terminate()); return ws;
  }
  return { connect, transport, send: (value, generation = 1) => events.emit("video", { type: "frame", frame: frame(value), generation, capturedAt: 123456 }), expire: () => { valid = false; }, state: state => events.emit("video", { type: "state", state, generation: 2 }) };
}
test("acknowledged video keeps one in flight and sends only the newest capture after presentation", async t => {
  const f = await fixture(t), ws = await f.connect(), received = [];
  ws.on("message", bytes => received.push(bytes));
  f.send(1); await pause(20); assert.equal(received.length, 1);
  assert.equal(received[0].subarray(0, 4).toString(), "RHSS"); assert.equal(received[0].readDoubleBE(12), 123456);
  f.send(2); f.send(3); f.send(4); await pause(20); assert.equal(received.length, 1);
  ws.send(JSON.stringify({ ack: 999 })); await pause(20); assert.equal(received.length, 1);
  ws.send(JSON.stringify({ ack: received[0].readUInt32BE(4) })); await pause(20);
  assert.equal(received.length, 2); assert.deepEqual(received[1].subarray(20), frame(4));
  ws.send(JSON.stringify({ ack: received[0].readUInt32BE(4) })); await pause(20); assert.equal(received.length, 2);
  ws.send(JSON.stringify({ ack: received[1].readUInt32BE(4) })); await pause(20); assert.equal(received.length, 2);
});
test("cross-site or expired viewer upgrades cannot open video", async t => {
  const f = await fixture(t);
  await assert.rejects(f.connect({ Origin: "https://unrelated.example" }), /403/);
  await assert.rejects(f.connect({}, "unknown_viewer_1234567890"), /403/);
  assert.equal(f.transport.size(), 0);
});
test("source changes discard pending old captures and release or expired leases close owned sockets", async t => {
  const f = await fixture(t), ws = await f.connect(), received = [];
  ws.on("message", bytes => received.push(bytes));
  f.send(1); await pause(20); const first = received[0]; f.send(2); f.state("starting");
  ws.send(JSON.stringify({ ack: first.readUInt32BE(4) })); await pause(20);
  assert.equal(received.filter(Buffer.isBuffer).length, 1);
  f.send(3, 2); await pause(20); assert.equal(received.at(-1).readUInt32BE(8), 2); assert.deepEqual(received.at(-1).subarray(20), frame(3));
  const closed = once(ws, "close"); f.expire(); f.send(4, 2); await Promise.race([closed, pause(1500).then(() => { throw Error("expired viewer did not close"); })]);
  assert.equal(f.transport.size(), 0);
});
test("binary acknowledgement frames are rejected and packet fields preserve JPEG bytes", async t => {
  assert.deepEqual(packet(frame(7), 8, 9, 10).subarray(20), frame(7));
  const f = await fixture(t), ws = await f.connect();
  const closed = once(ws, "close"); ws.send(Buffer.from('{"ack":1}'));
  await closed; assert.equal(f.transport.size(), 0);
});
