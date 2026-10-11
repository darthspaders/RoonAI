"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../public/lyrion.js"), "utf8");
const css = fs.readFileSync(require.resolve("../public/lyrion.css"), "utf8");
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));

test("the Sources panel is titled Sources & Discovery and the setup pages sit in its Setup menu, not under the heading", () => {
  assert.match(source, /<div class="lyrionSourcesHead"><h2>Sources & Discovery<\/h2><details class="lyrionSetup" id="lyrionSetup"><summary>Setup<\/summary><ul>/);
  const menu = source.slice(source.indexOf('<details class="lyrionSetup"'), source.indexOf("</details>"));
  assert.deepEqual([...menu.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(m => [m[1], m[2]]),
    [["/soundcloud-setup.html", "Connect SoundCloud playlists"], ["/siriusxm-setup.html", "SiriusXM metadata"]]);
  assert.doesNotMatch(source, /<h2>Sources & discovery<\/h2><p>/);
  assert.doesNotMatch(source, /Sources & discovery/);
});

test("the Setup menu sits on the left under the heading and opens below its button, on top of the source list", () => {
  assert.match(css, /\.lyrionSourcesHead\s*\{[^}]*display:grid;justify-items:start/);
  assert.doesNotMatch(css, /\.lyrionSourcesHead\s*\{[^}]*justify-content:space-between/);
  assert.match(css, /\.lyrionSetup\s*\{[^}]*position:relative/);
  assert.match(css, /\.lyrionSetup ul\s*\{[^}]*position:absolute[^}]*left:0[^}]*z-index:\d+/);
});

function menuHarness() {
  const listeners = {};
  const menu = { open: false, contains: node => node === "inside", querySelector: () => summary };
  const summary = { focused: false, focus() { this.focused = true; } };
  const context = { $: id => (id === "lyrionSetup" ? menu : null), document: { addEventListener: (type, fn) => { listeners[type] = fn; } } };
  vm.runInNewContext(section("  const setupMenu=", "  const renderSystemChoices="), context);
  return { menu, summary, listeners };
}

test("the Setup menu closes on a click outside it or on Escape, and stays open for clicks inside", () => {
  const h = menuHarness();
  h.menu.open = true; h.listeners.click({ target: "inside" }); assert.equal(h.menu.open, true);
  h.listeners.click({ target: "elsewhere" }); assert.equal(h.menu.open, false);
  h.menu.open = true; h.listeners.keydown({ key: "Enter" }); assert.equal(h.menu.open, true);
  h.listeners.keydown({ key: "Escape" }); assert.equal(h.menu.open, false); assert.equal(h.summary.focused, true);
  h.summary.focused = false; h.listeners.keydown({ key: "Escape" }); assert.equal(h.summary.focused, false);
});

test("the playback system hint is title-cased like the controls around it", () => {
  assert.match(source, /<span id="playbackSystemHint" class="muted">Independent Players and Queues<\/span>/);
  assert.doesNotMatch(source, /Independent players and queues/);
});
