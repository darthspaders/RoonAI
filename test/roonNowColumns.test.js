"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const styles = fs.readFileSync(require.resolve("../public/styles.css"), "utf8");
const lyrion = fs.readFileSync(require.resolve("../public/lyrion.css"), "utf8");
const media = "@media (min-width: 1100px) and (orientation: landscape) and (not (pointer: coarse)) {";
const block = () => { const start = styles.lastIndexOf(media); return start < 0 ? "" : styles.slice(start); };
const player = "#playerView .player.player--regular:not(.isMaximized):not(.isFullWindow)";
const rule = (css, selector) => css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]*)\\}"))?.[1] || "";

test("Roon's regular Now Playing uses Lyrion's desktop Now playing columns, gap and padding", () => {
  const columns = lyrion.match(/\n#lyrionView \.lyrionNow \{[^}]*grid-template-columns:([^;]+);/)?.[1];
  assert.equal(columns, "minmax(190px,1fr) minmax(0,2.3fr) minmax(190px,1fr)");
  const roon = rule(block(), `  ${player}`);
  assert.match(roon, new RegExp(`grid-template-columns: ${columns.replace(/,/g, ", ").replace(/[()]/g, "\\$&")};`));
  assert.match(roon, /column-gap: 24px;/);
  assert.match(roon, /padding: 24px;/);
});

test("the Roon details column drops its card inset so its text gets the whole column, like Lyrion's", () => {
  assert.match(rule(block(), `  ${player} > .now`), /^\s*padding: 0;\s*border: 0;\s*$/);
});

test("touch tablets and portrait screens keep Roon's own stacked layouts", () => {
  assert.ok(styles.includes(media), "desktop landscape, non-touch only");
});
