"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8");
const lyrion = read("lyrion.js"), css = read("lyrion.css"), app = read("app.js");

test("the Source row starts with the shared fold button in the label column", () => {
  assert.match(lyrion, /<div class="lyrionToolbar lyrionSourceRow"><button type="button" id="lyrionSourceToggle" class="resultsToggle" aria-expanded="true" aria-controls="lyrionSourceChoices" title="Hide the sources">&#9662;<\/button><select id="lyrionSource">/);
  assert.match(lyrion, /const sourceChoices=\$\("lyrionSource"\)\.nextElementSibling;sourceChoices\.id="lyrionSourceChoices";/);
});

test("folding keeps only the selected source pill, so the active source stays visible", () => {
  assert.match(css, /#lyrionSourceChoices\.isFolded button:not\(\[aria-pressed="true"\]\) \{display:none;\}/);
  assert.match(lyrion, /sourceChoices\.classList\.toggle\("isFolded",folded\);setPanelFolded\("#lyrionSourceToggle",null,folded,"the sources"\)/);
});

test("the fold is remembered per browser and survives storage that throws", () => {
  assert.match(lyrion, /try\{localStorage\.setItem\("rabbitHole\.lyrionSourcesFolded",folded\?"1":"0"\);\}catch\{\}/);
  assert.match(lyrion, /try\{foldSources\(localStorage\.getItem\("rabbitHole\.lyrionSourcesFolded"\)==="1"\);\}catch\{foldSources\(false\);\}/);
});

test("the source pills, the search box and Back start on the same column after the toggles", () => {
  assert.match(css, /#lyrionView \{--lyrion-label-col:48px;\}/);
  assert.match(css, /:is\(#lyrionSourceToggle,#lyrionResultsToggle\) \{margin-right:calc\(var\(--lyrion-label-col\) - 34px\);\}/);
  assert.match(css, /#lyrionSearch \{padding-left:calc\(var\(--lyrion-label-col\) \+ 12px\);\}/);
});

test("the search box has no visible label, keeps an accessible name, and is capped so its buttons sit beside it", () => {
  assert.match(lyrion, /<form id="lyrionSearch" class="lyrionToolbar"><input id="lyrionQuery" type="search" aria-label="Search" placeholder="Artist, track or channel">/);
  assert.doesNotMatch(lyrion, /<label for="lyrionQuery">/);
  assert.match(css, /#lyrionSearch #lyrionQuery \{flex:1 1 320px;max-width:640px;\}/);
  assert.match(css, /@media\(max-width:600px\)\{#lyrionSearch \{padding-left:0;\} #lyrionSearch #lyrionQuery \{flex-basis:100%;max-width:none;\}/);
});

test("setPanelFolded can flip a toggle without hiding a body", () => {
  assert.match(app, /const body = bodySelector \? \$\(bodySelector\) : null;/);
});

test("on phones the source pills wrap beside the toggle instead of dropping below it", () => {
  assert.match(css, /\.lyrionSourceRow \{align-items:flex-start;flex-wrap:nowrap;\}/);
  assert.match(css, /#lyrionSourceToggle \{margin-top:5px;\}/);
  assert.match(css, /@media\(max-width:600px\)\{#lyrionSearch [^\n]* \.lyrionSourceRow #lyrionSourceChoices \{flex:1 1 0;\}\}/);
});
