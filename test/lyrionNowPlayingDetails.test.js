"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { LyrionClient } = require("../src/lyrionClient");

// Shapes below are trimmed from a live LMS 9.1.1 `status` response: a local FLAC and a SomaFM HLS stream.
const localTrack = { id: 198943, title: "Angels & Devils", artist: "Echo & The Bunnymen", album: "The Stars, The Oceans & The Moon",
  duration: 219.44, year: "2018", genre: "Post-Punk", type: "flc", samplerate: "44100", samplesize: "16", bitrate: "1011kbps VBR",
  tracknum: "7", disc: "1", disccount: "2", url: "file:///music/x.flac", "playlist index": 0 };
const stream = { id: "-94637026779280", title: "Groove Salad FLAC", duration: "0", year: "0", type: "HLS Radio", bitrate: "0",
  url: "https://hls.somafm.com/hls/groovesalad/FLAC/program.m3u8", "playlist index": 0 };

test("status asks LMS for year, genre, format, rate, depth, bitrate and track and disc numbers", async () => {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" }), calls = [];
  client.rpc = async (player, command) => { calls.push(command); return { mode: "play", player_connected: 1, playlist_tracks: 1, playlist_cur_index: 0, playlist_loop: [localTrack] }; };
  await client.status("p1");
  const tags = calls[0].find(part => /^tags:/.test(part)).slice(5);
  for (const letter of "ygorTItiq") assert.ok(tags.includes(letter), `tags:${tags} lacks ${letter}`);
});

test("a local track carries its LMS details and a stream carries only what LMS knows", () => {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  const local = client.track(localTrack);
  assert.deepEqual(local.details, { year: 2018, genre: "Post-Punk", format: "flc", sampleRate: 44100, bitDepth: 16, bitrate: "1011kbps VBR", trackNumber: 7, disc: 1, discCount: 2 });
  assert.deepEqual(client.track(stream).details, { year: 0, genre: "", format: "HLS Radio", sampleRate: 0, bitDepth: 0, bitrate: "", trackNumber: 0, disc: 0, discCount: 0 });
  assert.equal(client.track({ ...localTrack, genre: "No Genre" }).details.genre, "");
});

const source = fs.readFileSync(require.resolve("../public/lyrion.js"), "utf8");
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const rows = (track, duration) => {
  const context = { time: n => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}` };
  vm.runInNewContext(section("  function lyrionDetailRows(", "  function renderLyrionDetails("), context);
  return JSON.parse(JSON.stringify(context.lyrionDetailRows(track, duration)));
};

test("Now playing shows track length, release year, genre, format and track number for a local track", () => {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  assert.deepEqual(rows(client.track(localTrack), 219.44), [
    ["Track length", "3:39"], ["Released", "2018"], ["Genre", "Post-Punk"],
    ["Format", "FLAC · 44.1 kHz / 16-bit · 1011 kbps VBR"], ["Track", "7 · Disc 1 of 2"]]);
});

test("a stream shows Live stream and its stream type, and no empty rows", () => {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  assert.deepEqual(rows(client.track(stream), 0), [["Track length", "Live stream"], ["Format", "HLS Radio"]]);
  assert.deepEqual(rows(null, 0), []);
});

test("formats name the codec, show whole kilohertz without decimals and skip a single disc", () => {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  const hires = client.track({ ...localTrack, type: "dsf", samplerate: "2822400", samplesize: "1", bitrate: "", disccount: "1", tracknum: "3" });
  assert.deepEqual(rows(hires, 300).filter(r => ["Format", "Track"].includes(r[0])), [["Format", "DSD · 2822.4 kHz / 1-bit"], ["Track", "3"]]);
  const alac = client.track({ ...localTrack, type: "alc", samplerate: "96000", samplesize: "24", bitrate: "3000kbps" });
  assert.equal(rows(alac, 300).find(r => r[0] === "Format")[1], "ALAC · 96 kHz / 24-bit · 3000 kbps");
});

function element() {
  return { children: [], hidden: false, textContent: "", classList: { set: new Set(), toggle(n, on) { on ? this.set.add(n) : this.set.delete(n); } },
    replaceChildren(...n) { this.children = n; }, append(...n) { this.children.push(...n); } };
}
function systemHarness() {
  const nodes = Object.fromEntries(["lyrionSystem", "lyrionTempCpu", "lyrionTempGpu", "lyrionTempCpuChip", "lyrionTempGpuChip"].map(id => [id, element()]));
  const context = { $: id => nodes[id], pcMonitorTempText: v => v == null ? "--" : `${Math.round(v)}C`,
    setPcTempChipState: (chip, v) => chip.classList.toggle("isHot", v >= 80) };
  vm.runInNewContext(section("  function renderLyrionSystem(", "  async function refreshLyrionSystem("), context);
  return { nodes, render: context.renderLyrionSystem };
}

test("the System block shows the monitor's CPU and GPU temperatures with Roon's formatting and heat colours", () => {
  const h = systemHarness();
  h.render({ connected: true, cpu: { temperatureC: 66.4 }, gpu: { temperatureC: 85 } });
  assert.equal(h.nodes.lyrionSystem.hidden, false);
  assert.deepEqual([h.nodes.lyrionTempCpu.textContent, h.nodes.lyrionTempGpu.textContent], ["66C", "85C"]);
  assert.deepEqual([h.nodes.lyrionTempCpuChip.classList.set.has("isHot"), h.nodes.lyrionTempGpuChip.classList.set.has("isHot")], [false, true]);
});

test("the System block hides when there is no monitor reading", () => {
  const h = systemHarness();
  h.render({ connected: false, error: "PC monitor is not configured" });
  assert.equal(h.nodes.lyrionSystem.hidden, true);
  h.render(null);
  assert.equal(h.nodes.lyrionSystem.hidden, true);
});

test("the System chips in the Lyrion rail are a compact size, not the fullscreen overlay's", () => {
  const css = fs.readFileSync(require.resolve("../public/lyrion.css"), "utf8");
  assert.match(css, /#lyrionView \.lyrionTemps \.pcTempChip \{[^}]*min-height:36px;[^}]*padding:0 14px;/);
  assert.match(css, /#lyrionView \.lyrionTemps \.pcTempChip span \{[^}]*font-size:11px;/);
  assert.match(css, /#lyrionView \.lyrionTemps \.pcTempChip strong \{[^}]*font-size:20px;/);
});
