"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createModelReviewAudit,
  classifyModelReviewChange,
  modelReviewAuditItem,
  recordModelReviewAudit
} = require("../src/modelReviewAudit");

test("model review audit classifies score movement", () => {
  assert.equal(classifyModelReviewChange({}, 70, 74), "boosted");
  assert.equal(classifyModelReviewChange({}, 70, 67), "downranked");
  assert.equal(classifyModelReviewChange({}, 70, 71), "unchanged");
  assert.equal(classifyModelReviewChange({ rejected: true }, 70, 68), "warning");
  assert.equal(classifyModelReviewChange({ rejected: true }, 70, 0, true), "rejected");
});

test("model review audit records compact examples and counts", () => {
  const audit = createModelReviewAudit();
  const score = {
    trackId: "123",
    finalScore: 82,
    scores: { genreConfidence: 76 },
    why: ["Strong metadata fit"]
  };
  const item = modelReviewAuditItem({
    artist: "Example Artist",
    title: "Example Track"
  }, score, 70, 78, "boosted");

  recordModelReviewAudit(audit, item, "boosted");
  recordModelReviewAudit(audit, item, "downranked");
  recordModelReviewAudit(audit, item, "rejected");
  recordModelReviewAudit(audit, item, "warning");
  recordModelReviewAudit(audit, item, "unchanged");

  assert.equal(audit.boostedCount, 1);
  assert.equal(audit.downrankedCount, 1);
  assert.equal(audit.rejectedCount, 1);
  assert.equal(audit.warningCount, 1);
  assert.equal(audit.unchangedCount, 1);
  assert.equal(audit.boosted[0].label, "Example Track - Example Artist");
  assert.equal(audit.boosted[0].delta, 8);
  assert.equal(audit.boosted[0].reason, "Strong metadata fit");
});
