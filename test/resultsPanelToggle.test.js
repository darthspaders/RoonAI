"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const app = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
const fn = name => {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists in public/app.js`);
  const end = app.indexOf("\n}\n", start);
  return app.slice(start, end + 2);
};

function harness() {
  const toggle = { textContent: "", title: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
  const body = { hidden: false };
  const context = { state: { resultsCollapsed: false }, $: s => ({ "#resultsToggle": toggle, "#resultsBody": body }[s] || null) };
  vm.runInNewContext([fn("setResultsCollapsed"), "this.setResultsCollapsed = setResultsCollapsed;"].join("\n"), context);
  return { context, toggle, body };
}

test("collapsing the results panel hides the track list and flips the toggle", () => {
  const { context, toggle, body } = harness();
  context.setResultsCollapsed(true);
  assert.equal(body.hidden, true);
  assert.equal(toggle.attrs["aria-expanded"], "false");
  assert.equal(context.state.resultsCollapsed, true);
  context.setResultsCollapsed(false);
  assert.equal(body.hidden, false);
  assert.equal(toggle.attrs["aria-expanded"], "true");
  assert.notEqual(toggle.textContent, "");
});

test("the track list and queue report sit inside the collapsible body", () => {
  const start = html.indexOf('<div id="resultsBody"');
  assert.notEqual(start, -1, "resultsBody exists");
  const body = html.slice(start, html.indexOf("</section>", start));
  assert.match(body, /id="queueReport"/);
  assert.match(body, /id="tracks"/);
  assert.match(html, /id="resultsToggle"[^>]*aria-controls="resultsBody"/);
  assert.match(html, /id="resultsToggle"[^>]*aria-expanded="true"/);
});

test("starting a Generate expands the list before the working placeholder is shown", () => {
  const working = app.indexOf("Building a TIDAL-first discovery pool.");
  assert.notEqual(working, -1);
  const before = app.slice(app.lastIndexOf("\n  try {", working) - 600, working);
  assert.match(before, /setResultsCollapsed\(false\)/);
});

test("the toggle and the title both toggle the list", () => {
  assert.match(app, /\$\("#resultsToggle"\)\.addEventListener\("click"/);
  assert.match(app, /\$\("#resultTitle"\)\.addEventListener\("click"/);
});
