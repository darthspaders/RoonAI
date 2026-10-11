"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { parseHqplayerStatus, createHqplayerControl } = require("../src/hqplayerControl");
const { LyrionClient } = require("../src/lyrionClient");

// Trimmed from a live HQPlayer Embedded 6.2.3 `<Status subscribe="0" />` reply.
const DSD = '<?xml version="1.0" encoding="utf-8"?><Status active_bits="1" active_channels="2" active_filter="poly-sinc-gauss-xla" active_mode="SDM (DSD)" active_rate="22579200" active_shaper="ASDM7ECv3" process_speed="1.40585626139028941" state="2"><metadata bits="16" mime="audio/x-flac" samplerate="44100" song="Lips Like Sugar"/></Status>';
const PCM = '<?xml version="1.0" encoding="utf-8"?><Status active_bits="32" active_filter="sinc-L" active_mode="PCM" active_rate="352800" active_shaper="" process_speed="3.2" state="2"/>';

test("an HQPlayer status reply gives its output mode, rate, depth, filter, shaper, speed and source", () => {
  assert.deepEqual(parseHqplayerStatus(DSD), { state: 2, mode: "SDM (DSD)", rate: 22579200, bits: 1, filter: "poly-sinc-gauss-xla", shaper: "ASDM7ECv3", speed: 1.40585626139028941, source: { rate: 44100, bits: 16, mime: "audio/x-flac" } });
  assert.deepEqual(parseHqplayerStatus(PCM), { state: 2, mode: "PCM", rate: 352800, bits: 32, filter: "sinc-L", shaper: "", speed: 3.2, source: null });
  assert.equal(parseHqplayerStatus("<Error/>"), null);
});

function fakeConnect(reply, record = []) {
  return ({ host, port }) => {
    const socket = new EventEmitter();
    record.push({ host, port });
    socket.setTimeout = (ms, fn) => { socket.timeoutFn = fn; };
    socket.write = data => { socket.sent = data; if (reply !== null) setImmediate(() => { for (const part of [reply.slice(0, 40), reply.slice(40)]) socket.emit("data", Buffer.from(part)); }); };
    socket.destroy = () => { socket.destroyed = true; };
    setImmediate(() => socket.emit("connect"));
    return socket;
  };
}

test("the control client asks HQPlayer's port 4321 for its status, reads a split reply and caches it briefly", async () => {
  let now = 0;
  const calls = [];
  const control = createHqplayerControl({ connect: fakeConnect(DSD, calls), clock: () => now });
  assert.equal((await control.status("192.168.60.76")).rate, 22579200);
  assert.deepEqual(calls, [{ host: "192.168.60.76", port: 4321 }]);
  await control.status("192.168.60.76");
  assert.equal(calls.length, 1);
  now += 3000;
  await control.status("192.168.60.76");
  assert.equal(calls.length, 2);
});

test("an unreachable or silent HQPlayer reports null instead of stalling", async () => {
  const silent = createHqplayerControl({ connect: options => { const s = fakeConnect(null)(options); setImmediate(() => s.timeoutFn()); return s; } });
  assert.equal(await silent.status("192.168.60.76"), null);
  const refused = createHqplayerControl({ connect: () => { const s = new EventEmitter(); s.setTimeout = () => {}; s.write = () => {}; s.destroy = () => {}; setImmediate(() => s.emit("error", new Error("ECONNREFUSED"))); return s; } });
  assert.equal(await refused.status("192.168.60.76"), null);
});

function lmsClient(model) {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  client.rpc = async (player, command) => command[0] === "serverstatus"
    ? { players_loop: [{ playerid: "p1", name: "HQPlayer (HQPlayerEmbedded)", connected: 1, model }] }
    : { mode: "play", player_connected: 1, player_ip: "192.168.60.76:52550", playlist_tracks: 0 };
  return client;
}

test("Lyrion status carries HQPlayer's output for an HQPlayer bridge player, found at that player's own address", async () => {
  const hosts = [];
  const client = lmsClient("hqplayer");
  client.hqplayer = { status: async host => { hosts.push(host); return parseHqplayerStatus(DSD); } };
  assert.equal((await client.status("p1")).hqplayer.filter, "poly-sinc-gauss-xla");
  assert.deepEqual(hosts, ["192.168.60.76"]);
});

test("other players get no HQPlayer block and HQPlayer is never asked", async () => {
  const hosts = [];
  const client = lmsClient("squeezelite");
  client.hqplayer = { status: async host => { hosts.push(host); return parseHqplayerStatus(DSD); } };
  assert.equal((await client.status("p1")).hqplayer, null);
  assert.deepEqual(hosts, []);
});

const source = fs.readFileSync(require.resolve("../public/lyrion.js"), "utf8");
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const rows = status => {
  const context = {};
  vm.runInNewContext(section("  function hqplayerRows(", "  function renderHqplayer("), context);
  return JSON.parse(JSON.stringify(context.hqplayerRows(status)));
};

test("Now playing names the DSD multiple, rate and depth HQPlayer outputs, with its filter, shaper and speed", () => {
  assert.deepEqual(rows(parseHqplayerStatus(DSD)), [
    ["HQPlayer output", "DSD512 · 22.5792 MHz / 1-bit SDM"], ["Filter", "poly-sinc-gauss-xla"], ["Shaper", "ASDM7ECv3"], ["Speed", "1.4x realtime"]]);
});

test("PCM output reads in kHz with its depth, and an empty shaper or missing status adds no rows", () => {
  assert.deepEqual(rows(parseHqplayerStatus(PCM)), [["HQPlayer output", "PCM · 352.8 kHz / 32-bit"], ["Filter", "sinc-L"], ["Speed", "3.2x realtime"]]);
  assert.deepEqual(rows(null), []);
});

test("the HQPlayer rows sit in the Playback section under the playback chain", () => {
  assert.match(source, /<p id="lyrionChain" class="muted">Lyrion<\/p><dl id="lyrionHqplayer" class="lyrionHqplayer" hidden><\/dl>/);
  const refresh = section("  async function refreshStatus()", "  async function loadPlayer()");
  assert.match(refresh, /renderHqplayer\(s\.hqplayer\);/);
});
