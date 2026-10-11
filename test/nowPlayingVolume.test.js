"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { LyrionClient } = require("../src/lyrionClient");
const { createLyrionApi } = require("../src/lyrionApi");

const widgetSource = fs.readFileSync(require.resolve("../public/volumeControl.js"), "utf8");
const indexHtml = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
const appSource = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
const lyrionSource = fs.readFileSync(require.resolve("../public/lyrion.js"), "utf8");

function element(tag) {
  const node = { tagName: tag, children: [], attributes: {}, listeners: {}, hidden: false, disabled: false, textContent: "", className: "", value: "", type: "",
    append(...n) { this.children.push(...n); }, replaceChildren(...n) { this.children = n; },
    setAttribute(k, v) { this.attributes[k] = String(v); }, getAttribute(k) { return this.attributes[k]; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this }); } };
  return node;
}
function widget() {
  const context = { window: {}, document: { createElement: element } };
  vm.runInNewContext(widgetSource, context);
  const root = element("div"), calls = [];
  const control = context.window.createVolumeControl(root, { set: value => calls.push(["set", value]), step: delta => calls.push(["step", delta]) });
  const [label, down, slider, up, readout] = root.children;
  return { root, control, calls, label, down, slider, up, readout };
}

test("the volume widget shows a level with a slider, down and up buttons and a readout", () => {
  const w = widget();
  w.control.update({ type: "number", min: 0, max: 100, step: 1, value: 24, is_muted: false });
  assert.equal(w.root.hidden, false);
  assert.equal(w.label.textContent, "Volume");
  assert.deepEqual([w.slider.type, w.slider.min, w.slider.max, w.slider.step, w.slider.value, w.slider.hidden], ["range", "0", "100", "1", "24", false]);
  assert.equal(w.readout.textContent, "24");
  assert.deepEqual([w.down.getAttribute("aria-label"), w.up.getAttribute("aria-label")], ["Volume down", "Volume up"]);
});

test("decibel volumes read in dB and a muted volume says so", () => {
  const w = widget();
  w.control.update({ type: "db", min: -80, max: 0, step: 0.5, value: -32.5, is_muted: true });
  assert.equal(w.readout.textContent, "-32.5 dB · Muted");
});

test("the slider sets the level when released and the buttons step it", () => {
  const w = widget();
  w.control.update({ type: "number", min: 0, max: 100, step: 1, value: 24 });
  w.slider.value = "40"; w.slider.fire("input");
  assert.equal(w.readout.textContent, "40");
  assert.deepEqual(w.calls, []);
  w.slider.fire("change");
  w.down.fire("click"); w.up.fire("click");
  assert.deepEqual(w.calls, [["set", 40], ["step", -1], ["step", 1]]);
});

test("a level update while the slider is held does not yank it back", () => {
  const w = widget();
  w.control.update({ type: "number", min: 0, max: 100, step: 1, value: 24 });
  w.slider.fire("pointerdown"); w.slider.value = "60";
  w.control.update({ type: "number", min: 0, max: 100, step: 1, value: 24 });
  assert.equal(w.slider.value, "60");
  w.slider.fire("change");
  w.control.update({ type: "number", min: 0, max: 100, step: 1, value: 60 });
  assert.equal(w.slider.value, "60");
  w.control.update({ type: "number", min: 0, max: 100, step: 1, value: 30 });
  assert.equal(w.slider.value, "30");
});

test("a step-only volume keeps just the buttons, and no volume hides the widget", () => {
  const w = widget();
  w.control.update({ type: "incremental" });
  assert.deepEqual([w.root.hidden, w.slider.hidden, w.readout.hidden, w.down.hidden, w.up.hidden], [false, true, true, false, false]);
  w.control.update(null);
  assert.equal(w.root.hidden, true);
});

test("the volume widget loads before both players", () => {
  const scripts = [...indexHtml.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const at = name => scripts.findIndex(src => src.startsWith(`/${name}?`) || src === `/${name}`);
  assert.ok(at("volumeControl.js") >= 0 && at("volumeControl.js") < at("app.js") && at("volumeControl.js") < at("lyrion.js"), JSON.stringify(scripts));
});

test("LMS status carries the player volume, its mute state and whether LMS controls it", async () => {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  const status = async extra => { client.rpc = async () => ({ mode: "play", player_connected: 1, playlist_tracks: 0, ...extra }); return (await client.status("p1")).volume; };
  assert.deepEqual(await status({ "mixer volume": 35, use_volume_control: 1 }), { type: "number", min: 0, max: 100, step: 1, value: 35, is_muted: false });
  assert.deepEqual(await status({ "mixer volume": -20, use_volume_control: 1 }), { type: "number", min: 0, max: 100, step: 1, value: 20, is_muted: true });
  assert.equal(await status({ "mixer volume": 100, use_volume_control: 0 }), null);
  assert.equal(await status({ use_volume_control: 1 }), null);
});

test("the Lyrion volume endpoint sets a clamped level or a signed step on the chosen player", async () => {
  const calls = [];
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  client.rpc = async (player, command) => { calls.push([player, command]); return {}; };
  client.requirePlayer = async () => {};
  let body;
  const sent = [];
  const api = createLyrionApi({ roon: { getState: () => ({ zones: [] }) }, client, file: "does-not-exist", readJson: async () => body, sendJson: (res, status, value) => sent.push([status, value]) });
  for (body of [{ playerId: "p1", value: 140 }, { playerId: "p1", value: 22.6 }, { playerId: "p1", step: 2 }, { playerId: "p1", step: -3 }]) {
    await api.handle({ method: "POST" }, {}, new URL("http://rh.example/api/lyrion/volume"));
  }
  assert.deepEqual(calls, [["p1", ["mixer", "volume", "100"]], ["p1", ["mixer", "volume", "23"]], ["p1", ["mixer", "volume", "+2"]], ["p1", ["mixer", "volume", "-3"]]]);
  body = { playerId: "p1", value: "loud" };
  await assert.rejects(api.handle({ method: "POST" }, {}, new URL("http://rh.example/api/lyrion/volume")), /volume level or step/);
  assert.equal(calls.length, 4);
});

const section = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to));

test("Roon Now Playing drives the zone's first output that has a volume, absolutely or by step", async () => {
  const calls = [], updates = [];
  const context = { $: () => ({ id: "nowVolume" }), api: async (path, body) => calls.push([path, body]),
    window: { createVolumeControl: (root, handlers) => { context.handlers = handlers; return { update: v => updates.push(v) }; } } };
  vm.runInNewContext(section(appSource, "let nowVolumeControl", "function renderNowSourceQuality(") + "; this.renderNowVolume = renderNowVolume;", context);
  const volume = { type: "number", min: 0, max: 100, step: 1, value: 24 };
  context.renderNowVolume({ outputs: [{ output_id: "a" }, { output_id: "b", volume }] });
  context.renderNowVolume({ outputs: [{ output_id: "c" }] });
  context.renderNowVolume(null);
  assert.deepEqual(JSON.parse(JSON.stringify(updates)), [volume, null, null]);
  context.renderNowVolume({ outputs: [{ output_id: "b", volume }] });
  await context.handlers.set(31); await context.handlers.step(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["/api/volume", { outputId: "b", how: "absolute", value: 31 }], ["/api/volume", { outputId: "b", how: "relative_step", value: -1 }]]);
});

test("Roon and Lyrion Now Playing each have a volume row in their rail", () => {
  assert.match(indexHtml, /<p id="nowSourceFormat" class="nowSourceFormat" hidden><\/p>\s*<div id="nowVolume" class="nowVolume" hidden><\/div>/);
  assert.match(lyrionSource, /<p id="lyrionAlbum" class="muted"><\/p>(<dl id="lyrionDetails" class="lyrionDetails" hidden><\/dl>)?<div id="lyrionVolume" class="nowVolume" hidden><\/div>/);
  const refresh = section(lyrionSource, "  async function refreshStatus()", "  async function loadPlayer()");
  assert.match(refresh, /lyrionVolume\.update\(s\.connected\?s\.volume:null\);/);
  assert.match(appSource, /renderNowVolume\(zone\);/);
});

test("if the device settles on another level than the one sent, the slider follows it after a few seconds", () => {
  let now = 1000;
  const context = { window: {}, document: { createElement: element }, Date: { now: () => now } };
  vm.runInNewContext(widgetSource, context);
  const root = element("div"), control = context.window.createVolumeControl(root, { set() {}, step() {} }), slider = root.children[2];
  control.update({ type: "number", min: 0, max: 100, step: 1, value: 24 });
  slider.value = "61"; slider.fire("change");
  control.update({ type: "number", min: 0, max: 100, step: 1, value: 60 });
  assert.equal(slider.value, "61");
  now += 3500;
  control.update({ type: "number", min: 0, max: 100, step: 1, value: 60 });
  assert.equal(slider.value, "60");
});

test("the volume row fits a narrow rail: it never outgrows its container and the readout sits beside the + button", () => {
  const css = fs.readFileSync(require.resolve("../public/styles.css"), "utf8");
  const rule = css.match(/\n\.nowVolume \{[^}]*\}/)?.[0] || "";
  assert.match(rule, /grid-template-columns: max-content 30px minmax\(40px, 1fr\) 30px max-content;/);
  assert.match(rule, /width: 100%;/);
  assert.match(rule, /min-width: 0;/);
  assert.match(css, /\.nowVolume \.volumeReadout \{[^}]*min-width: 3ch;[^}]*text-align: left;/);
});

test("the volume slider shows a hand when it can be dragged and a grabbing cursor while dragged, like the position sliders", () => {
  const css = fs.readFileSync(require.resolve("../public/styles.css"), "utf8");
  assert.match(css, /\.nowVolume \.volumeSlider:not\(:disabled\) \{\s*cursor: pointer;\s*\}/);
  assert.match(css, /\.nowVolume \.volumeSlider:not\(:disabled\):active \{\s*cursor: grabbing;\s*\}/);
});
