"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { makeRecord, classifyPair, buildReport, readSnapshot, renderMarkdown, validIsrc } = require("../scripts/audit-recording-duplicates");

function fixture(id, { identity = {}, bp = {}, omitBp = false } = {}) {
  return makeRecord({ id, identity_key: `text:artist|track|${id}`, artist: "Artist", title: "Track", album: "Album", duration_ms: 400000, ...identity }, omitBp ? null : { beatport_track_id: "100", release_id: "20", release_title: "Album", duration_ms: 400500, isrc: "GBABC2400001", raw_json: JSON.stringify({ name: "Track", mix_name: "Original Mix", artists: [{ name: "Artist", id: 30 }] }), ...bp });
}

test("same provider recording with compatible metadata is a duplicate identity, not an audio hash claim", () => {
  const pair = classifyPair(fixture(1), fixture(2));
  assert.equal(pair.category, "exact_duplicate");
  assert.match(pair.reasons[0], /not verified byte-identical/);
});

test("different provider/release IDs with shared ISRC and compatible duration identify a release variant", () => {
  const left = fixture(1);
  const right = fixture(2, { identity: { tidal_id: "222", album: "Compilation" }, bp: { beatport_track_id: "101", release_id: "21", release_title: "Compilation", duration_ms: 401000 } });
  assert.equal(classifyPair(left, right).category, "different_release");
});

test("ampersand and comma artist credits use the existing catalog normalizer", () => {
  const bp = { raw_json: JSON.stringify({ name: "Track", mix_name: "Original Mix", artists: [{ name: "Artist A" }, { name: "Artist B" }] }) };
  assert.equal(classifyPair(fixture(1, { identity: { artist: "Artist A & Artist B" }, bp }), fixture(2, { identity: { artist: "Artist B, Artist A" }, bp })).category, "exact_duplicate");
});

test("Calinerie-style long playback with hidden Ambient Version enrichment is a mismatch", () => {
  const ambient = fixture(2, { identity: { duration_ms: 500000 }, bp: { beatport_track_id: "101", duration_ms: 271906, isrc: "GBABC2400002", raw_json: JSON.stringify({ name: "Track", mix_name: "Ambient Version", artists: [{ name: "Artist" }] }) } });
  assert.ok(ambient.conflicts.some(reason => reason.includes("duration difference")));
  assert.equal(ambient.facts[1].version.label, "Ambient Version");
  assert.equal(classifyPair(fixture(1), ambient).category, "version_mismatch");
});

test("a shared ISRC never overrides an explicit remix disagreement", () => {
  const left = fixture(1, { identity: { title: "Track (Alpha Remix)", mix_version: "Alpha Remix", isrc: "GBABC2400001" }, omitBp: true });
  const right = fixture(2, { identity: { title: "Track (Beta Remix)", mix_version: "Beta Remix", isrc: "GBABC2400001" }, omitBp: true });
  assert.equal(classifyPair(left, right).category, "version_mismatch");
});

test("different explicit remixes with distinct ISRCs are separate recordings", () => {
  const left = fixture(1, { identity: { title: "Track (Alpha Remix)", isrc: "GBABC2400001" }, omitBp: true });
  const right = fixture(2, { identity: { title: "Track (Beta Remix)", isrc: "GBABC2400002" }, omitBp: true });
  assert.equal(classifyPair(left, right).category, "distinct_recording");
});

test("generic alternate labels are preserved even when semantic normalization strips both", () => {
  const left = fixture(1, { identity: { mix_version: "Ambient Version" }, omitBp: true });
  const right = fixture(2, { identity: { mix_version: "Main Version" }, omitBp: true });
  assert.equal(classifyPair(left, right).category, "distinct_recording");
});

test("same title by different artists is a homonym, not a merge", () => {
  const left = fixture(1, { omitBp: true });
  const right = fixture(2, { identity: { artist: "Different Artist" }, omitBp: true });
  assert.equal(classifyPair(left, right).category, "distinct_recording");
});

test("a shared Beatport enrichment or similar text alone cannot prove recording equivalence", () => {
  assert.equal(classifyPair(fixture(1, { omitBp: true }), fixture(2, { omitBp: true })).category, "needs_review");
  assert.equal(classifyPair(fixture(1, { bp: { isrc: "" } }), fixture(2, { bp: { isrc: "" } })).category, "needs_review");
  assert.equal(classifyPair(fixture(1), fixture(2, { identity: { duration_ms: null } })).category, "needs_review");
});

test("radio station metadata and incomplete provider credits are unresolved, not legitimate recording matches", () => {
  const station = fixture(1, { identity: { title: "Progressive -DI.FM", artist: "First artist" }, omitBp: true });
  const station2 = fixture(2, { identity: { title: "Progressive -DI.FM", artist: "Second artist" }, omitBp: true });
  assert.equal(classifyPair(station, station2).category, "needs_review");
  const partialCredit = fixture(2, { bp: { raw_json: JSON.stringify({ name: "Track", mix_name: "Original Mix", artists: [{ name: "Artist" }, { name: "Collaborator" }] }) } });
  assert.equal(classifyPair(fixture(1), partialCredit).category, "needs_review");
});

test("extended modifier on a named remix cannot disappear in semantic normalization", () => {
  const left = fixture(1, { identity: { title: "Track (Alpha Remix)", isrc: "GBABC2400001" }, omitBp: true });
  const right = fixture(2, { identity: { title: "Track (Alpha Extended Remix)", isrc: "GBABC2400001" }, omitBp: true });
  assert.equal(classifyPair(left, right).category, "version_mismatch");
});

test("duration tolerance is strict and missing duration is not treated as zero", () => {
  assert.equal(classifyPair(fixture(1), fixture(2, { identity: { duration_ms: 402000 }, bp: { duration_ms: 402000 } })).category, "exact_duplicate");
  assert.equal(classifyPair(fixture(1), fixture(2, { identity: { duration_ms: 403000 }, bp: { duration_ms: 403000 } })).category, "needs_review");
  assert.equal(classifyPair(fixture(1), fixture(2, { identity: { duration_ms: 406000 }, bp: { duration_ms: 406000 } })).category, "version_mismatch");
  assert.equal(classifyPair(fixture(1), fixture(2, { identity: { duration_ms: null }, bp: { duration_ms: null } })).category, "needs_review");
});

test("different remaster labels require review rather than a different musical recording assertion", () => {
  const left = fixture(1, { identity: { mix_version: "2010 Remaster" }, omitBp: true });
  const right = fixture(2, { identity: { mix_version: "2020 Remaster" }, omitBp: true });
  assert.equal(classifyPair(left, right).category, "needs_review");
});

test("distinct TIDAL IDs alone do not prove whether matching audio belongs to different releases", () => {
  const left = fixture(1, { identity: { tidal_id: "101" } });
  const right = fixture(2, { identity: { tidal_id: "102" } });
  const result = classifyPair(left, right);
  assert.equal(result.category, "needs_review");
  assert.match(result.reasons[0], /Same-recording evidence is strong/);
});

test("invalid ISRC text is not a matching identifier", () => {
  assert.equal(validIsrc("GB-ABC-24-00001"), true);
  assert.equal(validIsrc("12345"), false);
  assert.equal(classifyPair(fixture(1, { bp: { isrc: "12345" } }), fixture(2, { bp: { isrc: "12345" } })).category, "needs_review");
});

test("explicit title/mix disagreement within one row is exposed", () => {
  const record = fixture(1, { identity: { title: "Track (Alpha Remix)", mix_version: "Beta Remix" }, omitBp: true });
  assert.ok(record.conflicts.some(reason => reason.includes("explicit mix contradicts title")));
});

test("candidate pairs are deduplicated across identifiers and not transitively treated as merge groups", () => {
  const records = [fixture(1), fixture(2), fixture(3, { identity: { duration_ms: 410000 }, bp: { duration_ms: 410000 } })];
  const report = buildReport({ records, generatedAt: "test", aliasCount: 0, connectionChanges: 0 });
  assert.equal(report.candidatePairs, 3);
  assert.equal(report.counts.exact_duplicate.pairs, 1);
  assert.equal(report.counts.version_mismatch.pairs, 2);
  assert.equal(report.groups, undefined);
  assert.match(renderMarkdown(report), /not transitively merged/);
});

test("read-only snapshot leaves schema/data unchanged and checks coverage links for contradictions", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recording-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fixture.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE track_identity (id INTEGER PRIMARY KEY, identity_key TEXT, artist TEXT, title TEXT, duration_ms INTEGER, isrc TEXT, tidal_id TEXT);
    INSERT INTO track_identity VALUES (1,'tidal:100','Artist','Track',500000,'GBABC2400001','100');
    INSERT INTO track_identity VALUES (2,'text:artist|track|','Artist','Track',272000,'GBABC2400002',NULL);
    CREATE TABLE sonic_coverage_work (identity_key TEXT, state TEXT, resolved_identity_key TEXT);
    INSERT INTO sonic_coverage_work VALUES ('text:artist|track|','embedded','tidal:100');`);
  db.close();
  const before = fs.readFileSync(file);
  const snapshot = readSnapshot(file);
  assert.equal(snapshot.connectionChanges, 0);
  assert.equal(snapshot.readOnly, true);
  assert.deepEqual(snapshot.records[1].linkedRowIds, [1]);
  assert.ok(snapshot.records[1].conflicts.some(reason => reason.includes("persisted-link:1:tidal:100")));
  assert.equal(classifyPair(...snapshot.records).category, "version_mismatch");
  assert.deepEqual(fs.readFileSync(file), before);
});
