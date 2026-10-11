"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const layerStart = styles.indexOf("@layer folds {");
const layer = layerStart === -1 ? "" : styles.slice(layerStart, styles.indexOf("\n}\n", layerStart));
const rule = selector => {
  const start = layer.indexOf(`\n\n  ${selector} {`);
  assert.notEqual(start, -1, `${selector} rule exists in @layer folds`);
  return layer.slice(start, layer.indexOf("\n  }", start));
};
const forced = (block, property) => assert.match(block, new RegExp(`${property}[^;]*!important;`), `${property} is forced`);

test("every disclosure marker is drawn by the same forced rule as the panel fold buttons", () => {
  assert.notEqual(layerStart, -1, "@layer folds exists");
  const shared = layer.slice(layer.indexOf("  .resultsToggle,\n  summary::before {"), layer.indexOf("\n  }", layer.indexOf("  .resultsToggle,\n  summary::before {")));
  assert.ok(shared.length > 0, "fold buttons and summary markers share one rule");
  for (const property of ["border-radius: 6px", "min-width: 34px", "min-height: 34px", "background:", "box-shadow:", "color: #eadcff", "opacity: 1"]) {
    forced(shared, property);
  }
  forced(rule("summary::before"), "width: 34px");
  forced(rule("summary::before"), "height: 34px");
  forced(rule("summary::before"), "transform: none");
});

test("a disclosure shows only the fold button: no native triangle and no second marker", () => {
  forced(rule("summary"), "list-style: none");
  forced(rule("summary::-webkit-details-marker"), "display: none");
  forced(rule("summary::after"), "content: none");
});

test("disclosures use the same closed and open glyphs as the panel fold buttons", () => {
  assert.match(app, /folded \? "\\u25B8" : "\\u25BE"/);
  forced(rule("summary::before"), 'content: "\\\\25B8"');
  forced(rule("details[open] > summary::before"), 'content: "\\\\25BE"');
});

test("hovering a disclosure gives its marker the button hover glow", () => {
  const hover = layer.slice(layer.indexOf("  .resultsToggle:hover,\n  summary:hover::before {"));
  assert.ok(layer.includes("  .resultsToggle:hover,\n  summary:hover::before {"));
  forced(hover, "box-shadow");
});
