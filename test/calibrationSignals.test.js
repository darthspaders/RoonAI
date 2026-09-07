"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calibrationIssueCount,
  calibrationIssueDetail,
  calibrationIssueLabel,
  calibrationIssueRate
} = require("../src/calibrationSignals");

test("calibration issue helpers combine model misses and wrong-genre prompt mismatches", () => {
  const entry = {
    total: 5,
    modelMisses: 1,
    promptMismatches: 2
  };

  assert.equal(calibrationIssueCount(entry), 3);
  assert.equal(calibrationIssueRate(entry), 0.6);
  assert.equal(calibrationIssueDetail(entry), "1 model, 2 wrong-genre");
  assert.equal(calibrationIssueLabel(entry), "3/5 feedback issues (1 model, 2 wrong-genre)");
});

test("calibration issue helpers handle empty buckets", () => {
  assert.equal(calibrationIssueCount({}), 0);
  assert.equal(calibrationIssueRate({}), 0);
  assert.equal(calibrationIssueDetail({}), "");
  assert.equal(calibrationIssueLabel({}), "0/0 feedback issues");
});
