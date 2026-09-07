"use strict";

function calibrationIssueCount(entry = {}) {
  return Number(entry.modelMisses || 0) + Number(entry.promptMismatches || 0);
}

function calibrationIssueRate(entry = {}) {
  const total = Number(entry.total || 0);
  return total ? Number((calibrationIssueCount(entry) / total).toFixed(2)) : 0;
}

function calibrationIssueDetail(entry = {}) {
  return [
    entry.modelMisses ? `${entry.modelMisses} model` : "",
    entry.promptMismatches ? `${entry.promptMismatches} wrong-genre` : ""
  ].filter(Boolean).join(", ");
}

function calibrationIssueLabel(entry = {}, label = "feedback issues") {
  const issues = calibrationIssueCount(entry);
  const total = Number(entry.total || 0);
  const detail = calibrationIssueDetail(entry);
  return `${issues}/${total} ${label}${detail ? ` (${detail})` : ""}`;
}

module.exports = {
  calibrationIssueCount,
  calibrationIssueDetail,
  calibrationIssueLabel,
  calibrationIssueRate
};
