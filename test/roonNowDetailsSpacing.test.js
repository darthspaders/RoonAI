"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const css = fs.readFileSync(require.resolve("../public/styles.css"), "utf8");
const block = selector => [...css.matchAll(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g"))].map(m => m[1]);

test("Roon's Now Playing detail rows pack at the top instead of stretching across a reserved height", () => {
  const owner = block(".player:is(.player--regular, .player--maximized, .player--fullscreen) .nowInfo .nowSourceFormat");
  assert.ok(owner.some(body => /align-content:\s*start;/.test(body)), owner.join("\n---\n"));
  const regular = block(".player.player--regular:not(.isMaximized):not(.isFullWindow) .nowInfo .nowSourceFormat");
  assert.equal(regular.some(body => /min-height:\s*calc\(8 \* /.test(body)), false, regular.join("\n---\n"));
});

test("the regular player spaces its detail rows like Lyrion's Now playing list", () => {
  const regular = block(".player.player--regular:not(.isMaximized):not(.isFullWindow) .nowInfo .nowSourceFormat");
  assert.ok(regular.some(body => /gap:\s*12px;/.test(body)), regular.join("\n---\n"));
});
