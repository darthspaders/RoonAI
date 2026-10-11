"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const lyrion = fs.readFileSync(path.join(__dirname, "..", "public", "lyrion.js"), "utf8");

test("the Lyrion source list has the shared fold button at the start of its browse bar", () => {
  assert.match(lyrion, /<div class="lyrionToolbar"><button type="button" id="lyrionResultsToggle" class="resultsToggle" aria-expanded="true" aria-controls="lyrionResultsBody" title="Hide the source list">&#9662;<\/button><button id="lyrionBack"/);
});

test("folding hides the items and Load more, while the browse bar stays visible", () => {
  assert.match(lyrion, /<div id="lyrionResultsBody"><ul id="lyrionResults" class="lyrionList"><\/ul><button id="lyrionMore" type="button" hidden>Load more<\/button><\/div>/);
  assert.match(lyrion, /setPanelFolded\("#lyrionResultsToggle","#lyrionResultsBody",folded,"the source list"\)/);
});

test("a new browse, search or Back unfolds the list, but Load more keeps it as it is", () => {
  const start = lyrion.indexOf("function renderItems(items, append=false) {");
  assert.notEqual(start, -1);
  assert.match(lyrion.slice(start, start + 200), /if \(!append\) \{ \$\("lyrionResults"\)\.replaceChildren\(\); foldResults\(false\); \}/);
});

test("the fold button works while another Lyrion action is busy", () => {
  assert.match(lyrion, /\$\("lyrionResultsToggle"\)\.onclick=\(\)=>foldResults\(!resultsFolded\);/);
});
