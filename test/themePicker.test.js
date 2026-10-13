"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../public/themePicker.js"), "utf8");
const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");

function harness({ cookie = "", response, fail = false } = {}) {
  const listeners = {};
  const select = {
    value: "", disabled: false, options: [],
    append(option) { this.options.push(option); },
    addEventListener(type, fn) { listeners[type] = fn; }
  };
  const document = {
    cookie,
    getElementById: (id) => (id === "themeSelect" ? select : null),
    createElement: () => ({ value: "", textContent: "" })
  };
  const location = { reloaded: 0, reload() { this.reloaded += 1; } };
  const fetch = async (url) => {
    assert.equal(url, "/api/themes");
    if (fail) throw new Error("offline");
    return { ok: true, json: async () => response };
  };
  const context = { document, location, fetch };
  vm.runInNewContext(source, context);
  return { select, document, location, listeners, settle: () => new Promise((r) => setImmediate(r)) };
}

const THEMES = { themes: [{ id: "copper", label: "Obsidian & Copper" }, { id: "original", label: "Original" }], default: "copper" };

test("the picker lists every theme the server offers and selects the default without a cookie", async () => {
  const h = harness({ response: THEMES });
  await h.settle();
  assert.deepEqual(h.select.options.map((o) => [o.value, o.textContent]), [["copper", "Obsidian & Copper"], ["original", "Original"]]);
  assert.equal(h.select.value, "copper");
});

test("the picker selects the theme saved in the cookie", async () => {
  const h = harness({ cookie: "a=1; rh_theme=original", response: THEMES });
  await h.settle();
  assert.equal(h.select.value, "original");
});

test("choosing a theme saves it in a site-wide cookie and reloads the page", async () => {
  const h = harness({ response: THEMES });
  await h.settle();
  h.select.value = "original";
  h.listeners.change();
  assert.match(h.document.cookie, /^rh_theme=original; path=\/; max-age=31536000; samesite=lax$/);
  assert.equal(h.location.reloaded, 1);
});

test("the picker is disabled when the theme list cannot be loaded", async () => {
  const h = harness({ fail: true });
  await h.settle();
  assert.equal(h.select.disabled, true);
  assert.equal(h.select.options.length, 0);
});

test("the Settings header carries the theme picker and loads its script", () => {
  assert.match(html, /<select id="themeSelect" aria-label="Colour theme"><\/select>/);
  assert.match(html, /<script src="\/themePicker\.js(\?v=[\w-]+)?"><\/script>/);
});

test("every Settings control shares one width and one label column", () => {
  const css = fs.readFileSync(require.resolve("../public/styles.css"), "utf8");
  const rule = (selector) => {
    const at = css.lastIndexOf(`${selector} {`);
    assert.notEqual(at, -1, `${selector} has a rule`);
    return css.slice(at, css.indexOf("}", at));
  };
  assert.ok(css.lastIndexOf(".settingsPanel > .topControls {") > css.indexOf(".settingsPanel > .topControls .zonePicker select {"));
  assert.match(rule(".settingsPanel > .topControls"), /display: flex;[\s\S]*flex-wrap: wrap;/);
  assert.match(rule(".settingsPanel > .topControls .aiModeControls"), /display: contents;/);
  const control = rule(".settingsPanel > .topControls :is(.aiModeControls label, .zonePicker)");
  assert.match(control, /flex: 0 1 var\(--settings-control-width\);/);
  assert.match(control, /width: var\(--settings-control-width\);/);
  assert.match(control, /flex-direction: row;/, "phones keep the label beside the select, as AI Mode does");
  assert.match(rule(".settingsPanel > .topControls :is(.aiModeControls label, .zonePicker) span"), /padding-left: 9px;/, "the label text keeps its inset from the pill edge");
  assert.match(rule(".settingsPanel > .topControls :is(.aiModeControls label, .zonePicker) span"), /flex: 0 0 var\(--settings-label-width\);/);
  const fieldSelector = `body:not(.playerFullWindow):not(.playerMaximized) .settingsPanel > .topControls :is(.aiModeControls label, .zonePicker) :is(
  input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]),
  select
)`;
  const field = rule(fieldSelector);
  const globalField = `body:not(.playerFullWindow):not(.playerMaximized) :is(
    input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]),
    select,
    textarea
  )`;
  assert.notEqual(css.indexOf(globalField), -1, "the app-wide 8px field rule this has to outrank still exists");
  assert.ok(fieldSelector.startsWith(globalField.slice(0, globalField.indexOf(":is("))) && fieldSelector.includes('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"])'),
    "the Settings field rule carries the global rule's whole selector plus the Settings scope, so it is strictly more specific");
  assert.match(field, /flex: 1 1 auto;[\s\S]*width: auto;/);
  assert.match(field, /border-radius: 999px;/, "the select is a pill nested in the pill, not a rectangle poking into its curve");
  assert.match(control, /padding: 5px;/, "the select sits an even 5px inside the pill on every side");
  assert.doesNotMatch(css, /\.themePicker \{/, "no theme-only sizing left over");
});
