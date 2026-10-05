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

function cardHarness(openKeys = []) {
  const context = {
    state: { openTrackDetails: new Set(openKeys) },
    escapeHtml: value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    tidalTrackUrl: () => "https://tidal.com/browse/track/1",
    trackPayload: track => track, jsonDataAttr: () => "payload", formatDuration: () => "5:36",
    trackKeyFor: track => `${track.artist}|${track.title}`.toLowerCase(),
    artistConfirmationBadgeHtml: () => "<span>BADGES</span>",
    matchSplitHtml: () => "<div>MATCH-SPLIT</div>", scoreBreakdownHtml: () => "<div>SCORE-BREAKDOWN</div>",
    whyMatchedHtml: () => "<div>WHY-MATCHED</div>", evidenceLedgerHtml: () => "<div>EVIDENCE-LEDGER</div>",
    statusChecksHtml: () => "<div>STATUS-CHECKS</div>", resultDiagnosticsHtml: () => "<div>DIAGNOSTICS</div>",
    feedbackButtonsHtml: () => "<button>FEEDBACK</button>"
  };
  vm.runInNewContext([fn("scoreBandFor"), fn("compactScoreBadgeHtml"), fn("trackDetailsSummaryHtml"), fn("trackCardHtml"),
    "this.trackCardHtml = trackCardHtml;"].join("\n"), context);
  return context;
}

const smithsTrack = {
  title: "This Charming Man (New York Vocal) [2008 Remaster]", artist: "The Smiths", label: "Warner Music UK Ltd",
  releaseDate: "2008-09-16", durationMs: 336000, score: 49, belowMinimum: true,
  scoreBreakdown: { promptMatch: { percent: 52, label: "Loose" }, tasteMatch: { percent: 84, label: "Taste-adjacent" } },
  tidal: { title: "This Charming Man" }, roon: { match: { title: "This Charming Man" } }
};
const between = (html, from, to) => html.slice(html.indexOf(from), html.indexOf(to) + to.length);

test("a result card keeps title, label, feedback and actions visible and folds the analysis into a collapsed details block", () => {
  const html = cardHarness().trackCardHtml(smithsTrack, 0);
  const details = between(html, '<details class="trackDetails"', "</details>");
  for (const block of ["MATCH-SPLIT", "SCORE-BREAKDOWN", "WHY-MATCHED", "EVIDENCE-LEDGER", "STATUS-CHECKS", "DIAGNOSTICS", "Source:", "TIDAL:", "Roon:"]) {
    assert.ok(details.includes(block), `${block} is inside the details block`);
  }
  const outside = html.replace(details, "");
  for (const visible of ["This Charming Man (New York Vocal)", "The Smiths", "Warner Music UK Ltd", "FEEDBACK", "Add Next", "Play Roon"]) {
    assert.ok(outside.includes(visible), `${visible} stays visible`);
  }
  assert.doesNotMatch(details.slice(0, details.indexOf(">")), /\sopen\b/);
});

test("the collapsed summary shows the score band, prompt match and taste match at a glance", () => {
  const html = cardHarness().trackCardHtml(smithsTrack, 0);
  const summary = between(html, "<summary", "</summary>");
  assert.match(summary, /Discovery 49 - Long shot - below minimum/);
  assert.match(summary, /Prompt 52%/);
  assert.match(summary, /Taste 84%/);
});

test("a card the listener opened stays open when the results re-render", () => {
  const html = cardHarness(["the smiths|this charming man (new york vocal) [2008 remaster]"]).trackCardHtml(smithsTrack, 0);
  assert.match(html, /<details class="trackDetails" data-track-key="the smiths\|this charming man \(new york vocal\) \[2008 remaster\]" open>/);
});

test("opening or closing a card's details is remembered by track identity", () => {
  const sandbox = { state: { openTrackDetails: new Set() } };
  vm.runInNewContext(`${fn("rememberTrackDetailsToggle")}; this.remember = rememberTrackDetailsToggle;`, sandbox);
  const key = "the smiths|this charming man (new york vocal) [2008 remaster]";
  const details = open => ({ open, matches: selector => selector === ".trackDetails", dataset: { trackKey: key } });
  sandbox.remember({ target: details(true) });
  assert.deepEqual([...sandbox.state.openTrackDetails], ["the smiths|this charming man (new york vocal) [2008 remaster]"]);
  sandbox.remember({ target: details(false) });
  assert.deepEqual([...sandbox.state.openTrackDetails], []);
  sandbox.remember({ target: { matches: () => false } });
  assert.deepEqual([...sandbox.state.openTrackDetails], []);
});
