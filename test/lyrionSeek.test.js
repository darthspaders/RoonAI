"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { LyrionClient } = require("../src/lyrionClient");
const { createLyrionApi } = require("../src/lyrionApi");

async function status(extra) {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  client.rpc = async () => ({ mode: "play", player_connected: 1, playlist_tracks: 1, playlist_cur_index: 0, time: 61, playlist_loop: [{ title: "Song", "playlist index": 0, url: "file:///a.flac", duration: 219.4 }], ...extra });
  return client.status("p1");
}

test("a track LMS can seek, with a length, is seekable; a live stream or a can_seek of 0 is not", async () => {
  assert.equal((await status({ can_seek: 1, duration: 219.4 })).canSeek, true);
  assert.equal((await status({ can_seek: 0, duration: 219.4 })).canSeek, false);
  assert.equal((await status({ can_seek: 1, duration: 0, playlist_loop: [{ title: "Groove Salad FLAC", "playlist index": 0, url: "https://hls.somafm.com/x.m3u8", duration: "0" }] })).canSeek, false);
});

test("the seek endpoint moves the chosen player to a position in seconds with LMS's time command", async () => {
  const calls = [];
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  client.rpc = async (player, command) => { calls.push([player, command]); return {}; };
  client.requirePlayer = async () => {};
  let body;
  const api = createLyrionApi({ roon: { getState: () => ({ zones: [] }) }, client, file: "does-not-exist", readJson: async () => body, sendJson: () => {} });
  for (body of [{ playerId: "p1", seconds: 95.5 }, { playerId: "p1", seconds: -4 }]) await api.handle({ method: "POST" }, {}, new URL("http://rh.example/api/lyrion/seek"));
  assert.deepEqual(calls, [["p1", ["time", "95.5"]], ["p1", ["time", "0"]]]);
  body = { playerId: "p1", seconds: "later" };
  await assert.rejects(api.handle({ method: "POST" }, {}, new URL("http://rh.example/api/lyrion/seek")), /position in seconds/);
  assert.equal(calls.length, 2);
});

const source = fs.readFileSync(require.resolve("../public/lyrion.js"), "utf8");
function element() {
  return { value: "0", max: "1", disabled: false, textContent: "", listeners: {}, style: { setProperty(name, value) { this[name] = value; } }, addEventListener(type, fn) { this.listeners[type] = fn; }, async fire(type) { return this.listeners[type]?.(); } };
}
function seekHarness() {
  const nodes = { lyrionProgress: element(), lyrionTime: element() }, calls = [];
  const context = { $: id => nodes[id], time: n => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`,
    api: async (route, body) => calls.push([route, body]), refreshStatus: async () => calls.push(["refreshStatus"]), message: text => calls.push(["message", text]) };
  vm.runInNewContext(source.slice(source.indexOf("  let seekHeld=false;"), source.indexOf("  let statusRequest=")), context);
  return { context, nodes, calls, bar: nodes.lyrionProgress };
}

test("the Lyrion position bar is a slider that follows playback and is enabled only when the track can seek", () => {
  const h = seekHarness();
  h.context.renderLyrionSeek({ duration: 219, position: 61, canSeek: true, state: "playing" });
  assert.deepEqual([h.bar.max, h.bar.value, h.bar.disabled, h.nodes.lyrionTime.textContent], ["219", "61", false, "1:01 / 3:39"]);
  h.context.renderLyrionSeek({ duration: 0, position: 3522, canSeek: false, state: "playing" });
  assert.deepEqual([h.bar.max, h.bar.value, h.bar.disabled, h.nodes.lyrionTime.textContent], ["1", "0", true, "Live stream"]);
});

test("dragging previews the new time, a status update does not yank the slider back, and releasing seeks there", async () => {
  const h = seekHarness();
  h.context.renderLyrionSeek({ duration: 219, position: 61, canSeek: true, state: "playing" });
  await h.bar.fire("pointerdown"); h.bar.value = "150"; await h.bar.fire("input");
  assert.equal(h.nodes.lyrionTime.textContent, "2:30 / 3:39");
  h.context.renderLyrionSeek({ duration: 219, position: 62, canSeek: true, state: "playing" });
  assert.equal(h.bar.value, "150");
  await h.bar.fire("change");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [["seek", { seconds: 150 }], ["refreshStatus"]]);
  h.context.renderLyrionSeek({ duration: 219, position: 151, canSeek: true, state: "playing" });
  assert.equal(h.bar.value, "151");
});

test("the Lyrion stage footer uses a range input for the position, not a display-only progress bar", () => {
  assert.match(source, /<input id="lyrionProgress" type="range" min="0" max="1" step="1" value="0" aria-label="Playback position" disabled>/);
  assert.doesNotMatch(source, /<progress id="lyrionProgress"/);
  assert.match(source, /renderLyrionSeek\(s\);/);
});

test("both players' position sliders show they can be grabbed, and a disabled one does not", () => {
  const css = fs.readFileSync(require.resolve("../public/styles.css"), "utf8") + fs.readFileSync(require.resolve("../public/lyrion.css"), "utf8");
  assert.match(css, /#seekSlider:not\(:disabled\),\s*#lyrionProgress:not\(:disabled\) \{\s*cursor: pointer;\s*\}/);
  assert.match(css, /#seekSlider:not\(:disabled\):active,\s*#lyrionProgress:not\(:disabled\):active \{\s*cursor: grabbing;\s*\}/);
  assert.match(css, /#seekSlider:disabled,\s*#lyrionProgress:disabled \{\s*cursor: default;\s*\}/);
});

test("Roon's and Lyrion's position sliders share one visible style at every width: a 6px filled track and a 16px thumb", () => {
  const css = fs.readFileSync(require.resolve("../public/styles.css"), "utf8");
  const both = ".player.player--regular:not(.isMaximized):not(.isFullWindow) > .seekBlock #seekSlider,\n#lyrionView .lyrionStageFooter #lyrionProgress";
  const tail = css.slice(css.lastIndexOf("/* One visible position slider"));
  assert.ok(tail.includes(both + " {"), "shared rule");
  assert.match(tail, /#lyrionProgress \{[^}]*height: 6px;[^}]*background: linear-gradient\(to right, var\(--accent\) 0 var\(--seek-progress, 0%\)/);
  assert.match(tail, /#lyrionProgress::-webkit-slider-thumb \{[^}]*width: 16px;[^}]*height: 16px;/);
  assert.equal(css.indexOf("/* One visible position slider") > css.lastIndexOf("height: 4px;"), true);
});

test("the Lyrion slider fills its track up to the playing or dragged position", () => {
  const h = seekHarness();
  h.context.renderLyrionSeek({ duration: 200, position: 50, canSeek: true, state: "playing" });
  assert.equal(h.bar.style["--seek-progress"], "25%");
  h.bar.value = "150"; h.bar.fire("input");
  assert.equal(h.bar.style["--seek-progress"], "75%");
});
