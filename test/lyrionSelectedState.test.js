"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const css = fs.readFileSync(require.resolve("../public/lyrion.css"), "utf8");
const styles = fs.readFileSync(require.resolve("../public/styles.css"), "utf8");
const rule = selector => css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"))?.[1] || "";

test("selected Lyrion pills and tabs use the app's selected-button edge, not the text accent", () => {
  const appSelected = styles.match(/:is\(button, \.buttonLink\):not\(\.viewTabs button\):not\(\.secondaryNavItems button\):is\(\.active, \[aria-pressed="true"\]\) \{\s*border-color: (rgba\([^)]*\))/)[1];
  assert.equal(appSelected, "rgba(217, 179, 255, 0.3)");
  const pill = rule('.lyrionChoices button[aria-pressed="true"],#lyrionView .lyrionChoices button[aria-pressed="true"]');
  assert.match(pill, /border-color:rgba\(217,179,255,\.3\)/);
  assert.doesNotMatch(pill, /border-color:var\(--accent\)/);
  const tab = rule('#lyrionView .lyrionTabs button[aria-selected="true"]');
  assert.match(tab, /border-bottom-color:rgba\(217,179,255,\.3\)/);
  assert.doesNotMatch(tab, /border-bottom-color:var\(--accent\)/);
});
