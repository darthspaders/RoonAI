"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TasteProfile } = require("../src/tasteProfile");
const { buildDiscoveryProfile, discoverTracks, scoreBreakdownFor } = require("../src/discoveryEngine");

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-taste-view-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new TasteProfile(path.join(directory, "taste.json"));
}

const track = { artist: "Solarstone", title: "Seven Cities", label: "Pure Trance", tidalUrl: "https://tidal.com/browse/track/123", durationMs: 480000, year: 2025 };

test("discovery taste reads reuse derived state without changing scoring or exposing writes", t => {
  const taste = setup(t);
  taste.record(track, "love");
  const options = { genres: "progressive trance", minDurationMinutes: 7, scoringMode: "taste-guided" };
  const profile = buildDiscoveryProfile(options);
  const expected = scoreBreakdownFor(track, options, taste, profile);
  const expectedSummary = taste.summary();
  let reads = 0;
  const read = taste.read.bind(taste);
  taste.read = () => { reads++; return read(); };
  const view = taste.createReadView();
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(scoreBreakdownFor(track, options, view, profile), expected);
    assert.equal(view.getFeedbackFor(track), "love");
    assert.deepEqual(view.getTopArtists(), ["Solarstone"]);
    assert.deepEqual(view.summary(), expectedSummary);
  }
  assert.equal(reads, 1);
  assert.equal(view.write, undefined);
  assert.equal(view.record, undefined);
  assert.throws(() => { view.read().feedback = {}; }, TypeError);
  const entry = Object.values(view.read().feedback)[0];
  assert.throws(() => { entry.rating = "never"; }, TypeError);
  assert.equal(taste.getFeedbackFor(track), "love");
});

test("a discovery taste view observes new feedback and external file replacement", t => {
  const taste = setup(t);
  taste.record(track, "love");
  const view = taste.createReadView();
  assert.equal(view.getFeedbackFor(track), "love");
  taste.record(track, "never");
  assert.equal(view.getFeedbackFor(track), "never");
  assert.deepEqual(view.adjustmentFor(track), taste.adjustmentFor(track));

  const profile = taste.read();
  Object.values(profile.feedback)[0].rating = "love";
  const replacement = `${taste.filePath}.new`;
  fs.writeFileSync(replacement, JSON.stringify(profile));
  fs.renameSync(replacement, taste.filePath);
  assert.equal(view.getFeedbackFor(track), "love");
  assert.deepEqual(view.summary(), taste.summary());
});

test("a discovery taste view recovers when its file is created or removed", t => {
  const taste = setup(t);
  const view = taste.createReadView();
  assert.equal(view.getFeedbackFor(track), "");
  taste.record(track, "dislike");
  assert.equal(view.getFeedbackFor(track), "dislike");
  fs.unlinkSync(taste.filePath);
  assert.equal(view.getFeedbackFor(track), "");
  assert.equal(view.summary().feedbackCount, 0);
});

test("discovery creates a fresh reusable taste reader for each run", async t => {
  const taste = setup(t);
  taste.record(track, "love");
  let reads = 0;
  const read = taste.read.bind(taste);
  taste.read = () => { reads++; return read(); };
  const run = () => discoverTracks({
    tidal: { isConfigured: () => true },
    options: { genres: "progressive trance", count: 1, minDurationMinutes: 7 },
    tasteProfile: taste,
    directCandidates: [track]
  });
  const first = await run();
  assert.equal(first.tracks.length, 1);
  assert.equal(reads, 1);
  assert.deepEqual((await run()).tracks, first.tracks);
  assert.equal(reads, 2, "the next run reads current feedback again");
});
