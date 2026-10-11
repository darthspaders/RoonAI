"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const read = file => fs.readFileSync(require.resolve(`../public/${file}`), "utf8");
const styles = read("styles.css"), lyrion = read("lyrion.css"), database = read("database.css");
const GROUPS = ":is(.lyrionChoices, .lyrionTabs, .secondaryNavItems, .lyrionCenterViews, .dbViewSwitch, .tidalLibraryFilters)";
const SELECTED = ':is(.active, [aria-pressed="true"], [aria-current="page"], [aria-selected="true"])';
const pillLayer = () => styles.slice(styles.lastIndexOf("@layer pills {"));
const block = (css, selector) => css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]*)\\}"))?.[1];
const declarations = text => text.replace(/\s+/g, " ").replace(/ !important/g, "").trim().split(";").map(d => d.trim()).filter(Boolean);

test("every choice-pill group shares one fully round pill, set in a layer so no per-view or phone rule can reshape it", () => {
  assert.ok(styles.includes("@layer pills {"), "pill layer");
  assert.deepEqual(declarations(block(pillLayer(), `${GROUPS} :is(button, a)`) || ""), ["border-radius: 999px"]);
  assert.match(block(pillLayer(), `${GROUPS} :is(button, a)`), /999px !important;/);
});

test("the selected pill in every group looks exactly like the primary nav's selected tab", () => {
  const nav = declarations(block(styles, "body:not(.playerFullWindow):not(.playerMaximized) .viewTabs.primaryNav button.active"));
  const pick = (list, prop) => list.find(d => d.startsWith(`${prop}:`));
  const pill = declarations(block(pillLayer(), `${GROUPS} button${SELECTED}`) || "");
  for (const prop of ["border", "background", "box-shadow", "color"]) assert.equal(pick(pill, prop), pick(nav, prop), prop);
  assert.equal((block(pillLayer(), `${GROUPS} button${SELECTED}`).match(/!important;/g) || []).length, 4);
});

test("Lyrion's section tabs sit in a rounded track like the primary nav, without the folder-tab underline", () => {
  const track = block(lyrion, ".lyrionTabs");
  assert.match(track, /padding:4px;/);
  assert.match(track, /border-radius:999px;/);
  assert.doesNotMatch(track, /border-bottom/);
  const tab = block(lyrion, "#lyrionView .lyrionTabs button");
  assert.match(tab, /border:1px solid transparent;background:transparent;box-shadow:none;/);
  assert.doesNotMatch(tab, /border-bottom|border-radius:6px/);
});

test("no group keeps its own selected colours to fight the shared pill", () => {
  assert.doesNotMatch(lyrion, /\.lyrionChoices button\[aria-pressed="true"\]|\.lyrionTabs button\[aria-selected="true"\]/);
  assert.doesNotMatch(database, /\.dbViewSwitch button\[aria-pressed="true"\]/);
  assert.doesNotMatch(styles, /^\s*(body:not\(\.playerFullWindow\):not\(\.playerMaximized\) )?(\.tidalLibraryFilters|\.secondaryNavItems) button\.active \{/m);
});

test("on a phone each choice group takes its own row under its label, and its pills keep their names on one line", () => {
  const phone = lyrion.match(/@media\(max-width:600px\)\{(.*)\}\s*$/m)?.[1] || "";
  assert.match(phone, /\.lyrionChoices\{flex-basis:100%;\}/);
  assert.match(phone, /\.lyrionChoices :is\(button,a\)\{white-space:nowrap;\}/);
});
