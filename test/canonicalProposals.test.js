"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { basis, recordingProposal, validateManifest, hash, RULESET } = require("../scripts/propose-canonical-links");

const row = (id, patch = {}) => ({ id, conflicts: [], primary: { artist: "Artist", title: "Song", mixVersion: "Original Mix", durationMs: 300000, isrc: "USABC1234567", ...patch } });
const pair = { a: 1, b: 2, category: "exact_duplicate", candidateReasons: ["tidal:123"], evidence: ["exact provider item"] };
test("parsed audit version objects cannot manufacture explicit version evidence", () => {
  const parsed = { kind: "none", explicit: false, normalized: "" };
  const rows = new Map([[1, row(1, { mixVersion: "", version: parsed })], [2, row(2, { mixVersion: "", version: parsed })]]);
  const result = recordingProposal(pair, rows);
  assert.equal(result.assessment, "NEEDS_EVIDENCE");
  assert.ok(result.missingEvidence.includes("version"));
});
test("compatible candidates remain PROPOSED without a canonical target or automatic verification", () => {
  const result = recordingProposal(pair, new Map([[1, row(1)], [2, row(2)]]));
  assert.equal(result.state, "PROPOSED");
  assert.equal(result.assessment, "READY_FOR_REVIEW");
  assert.equal(result.canonicalTargetId, null);
  assert.equal(result.automaticVerificationAllowed, false);
  assert.equal(result.id, recordingProposal(pair, new Map([[2, row(2)], [1, row(1)]])).id);
});
test("shared provider/ISRC evidence cannot override remix, credit or contaminated-row conflicts", () => {
  for (const patch of [{ mixVersion: "Ambient Version" }, { artist: "Other Artist" }, { durationMs: 280000 }]) {
    assert.equal(recordingProposal(pair, new Map([[1, row(1)], [2, row(2, patch)]])).assessment, "BLOCKED_CONFLICT");
  }
  const contaminated = { ...row(2), conflicts: ["wrong source attached"] };
  assert.equal(recordingProposal(pair, new Map([[1, row(1)], [2, contaminated]])).assessment, "BLOCKED_CONFLICT");
  assert.equal(recordingProposal(pair, new Map([[1, row(1)], [2, row(2, { mixVersion: "" })]])).assessment, "NEEDS_EVIDENCE");
});
test("a proposal never implicitly joins a third member through a similarity chain", () => {
  const records = new Map([[1, row(1)], [2, row(2)], [3, row(3, { mixVersion: "Radio Edit" })]]);
  assert.deepEqual(recordingProposal(pair, records).sourceRows, [1, 2]);
  assert.equal(recordingProposal({ ...pair, a: 2, b: 3 }, records).assessment, "BLOCKED_CONFLICT");
});
test("manifest rejects edits, legacy changes and new source observations while performing no writes", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE track_identity(id INTEGER PRIMARY KEY,title TEXT); INSERT INTO track_identity VALUES(1,'Song')");
  const first = basis(db), content = { ruleset: RULESET, basis: first, proposals: [] };
  const report = { ...content, manifestHash: hash(content) };
  const changes = db.prepare("SELECT total_changes() n").get().n;
  assert.equal(validateManifest(report, basis(db)).valid, true);
  assert.equal(db.prepare("SELECT total_changes() n").get().n, changes);
  assert.equal(validateManifest({ ...report, proposals: ["injected"] }, first).reason, "manifest-content-changed");
  db.exec("UPDATE track_identity SET title='Changed'");
  assert.equal(validateManifest(report, basis(db)).reason, "stale-source-or-ruleset");
  db.exec("UPDATE track_identity SET title='Song'; INSERT INTO track_identity VALUES(2,'new evidence')");
  assert.equal(validateManifest(report, basis(db)).valid, false);
});
