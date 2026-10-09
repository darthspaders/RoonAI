"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
const fn = name => {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists in public/app.js`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
};

function harness({ open = false } = {}) {
  const report = { hidden: true, innerHTML: "" };
  const context = {
    state: { queueReportOpen: open },
    $: selector => (selector === "#queueReport" ? report : null),
    escapeHtml: value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  };
  vm.runInNewContext([fn("queueReportSummaryText"), fn("queueReportHtml"), fn("showQueueReport"), fn("rememberQueueReportToggle"),
    "this.queueReportHtml = queueReportHtml; this.showQueueReport = showQueueReport; this.rememberQueueReportToggle = rememberQueueReportToggle;"].join("\n"), context);
  context.report = report;
  return context;
}

const queuedTrack = (title, artist) => ({ track: { title, artist, album: "Album", year: 1975 } });
const result = {
  requested: 50,
  queuedCount: 41,
  queued: Array.from({ length: 41 }, (_, i) => queuedTrack(`Track ${i + 1}`, "Artist")),
  failed: []
};
const between = (html, from, to) => html.slice(html.indexOf(from), html.indexOf(to) + to.length);

test("the queue report folds the added-track list into a details block that starts collapsed", () => {
  const html = harness().queueReportHtml(result);
  assert.match(html, /^\s*<details class="queueReportDetails">/);
  const details = between(html, "<details", "</details>");
  const summary = between(details, "<summary", "</summary>");
  const body = details.replace(summary, "");
  assert.ok(body.includes("Added tracks"), "the added-track list is inside the collapsed body");
  assert.ok(body.includes("Track 1") && body.includes("Track 18"), "the listed tracks are inside the collapsed body");
  assert.ok(!summary.includes("Track 1"), "no track rows in the summary");
});

test("the collapsed summary still says how many tracks were queued and where", () => {
  const summary = between(harness().queueReportHtml(result), "<summary", "</summary>");
  assert.match(summary, /Queued 41\/50/);
  assert.match(summary, /41 tracks added to the existing Roon queue/);
});

test("failed queue attempts are counted in the summary so they are not hidden by the fold", () => {
  const withFailures = { ...result, queuedCount: 39, queued: result.queued.slice(0, 39), failed: [{ track: { artist: "A", title: "B" }, reason: "No match" }, { track: { artist: "C", title: "D" } }] };
  const summary = between(harness().queueReportHtml(withFailures), "<summary", "</summary>");
  assert.match(summary, /2 failed/);
});

test("a report the listener has seen opened renders open again", () => {
  const ctx = harness();
  ctx.showQueueReport(result);
  assert.equal(ctx.report.hidden, false);
  assert.doesNotMatch(ctx.report.innerHTML.slice(0, ctx.report.innerHTML.indexOf(">") + 1), /\sopen/);
  ctx.rememberQueueReportToggle({ target: { matches: s => s === ".queueReportDetails", open: true } });
  ctx.showQueueReport(result);
  assert.match(ctx.report.innerHTML, /<details class="queueReportDetails" open>/);
  ctx.rememberQueueReportToggle({ target: { matches: s => s === ".queueReportDetails", open: false } });
  ctx.showQueueReport(result);
  assert.match(ctx.report.innerHTML, /<details class="queueReportDetails">/);
});

test("toggles from other details elements in the report do not change the remembered state", () => {
  const ctx = harness({ open: true });
  ctx.rememberQueueReportToggle({ target: { matches: () => false, open: false } });
  assert.equal(ctx.state.queueReportOpen, true);
});
