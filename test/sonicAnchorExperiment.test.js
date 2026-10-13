"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite"), { createHash } = require("node:crypto");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { encodeVector } = require("../src/sonicEmbeddingStore");
const { recordingGroup } = require("../src/sonicAnalysisPilot");
const { BATCHES, digest, validateStoredResult, createPrivateResultReceipt, readPrivateResultReceipt,
  grade, readDevelopmentSnapshot, evaluateAnchorExperiment } = require("../src/sonicAnchorExperiment");
const { argumentsFor, privateDirectory, markdown } = require("../scripts/sonic-anchor-experiment");
const MODELS = ["mert-fullsong", "mert-30s"];
const hash = value => createHash("sha256").update(String(value)).digest("hex");

function resultFixture(analyzer = MODELS[0]) {
  const spec = analysisSpec(analyzer), vector = Array(spec.dimensions).fill(0); vector[0] = 1;
  return { spec, source: { sourceSha256: hash("frozen-preview"), snapshotKey: `sonic-source-v1-${hash("source-snapshot")}`,
    sourceType: "beatport-preview", durationSeconds: 60,
    spans: [[15, 45]], byteLength: 12345, identityRelation: "exact", partialPreview: true },
  result: { specKey: spec.key, revision: spec.revision, sampleRate: spec.sampleRate, audioDurationSeconds: 60,
    analyzedSeconds: 30, sourceCoverage: .5, vector, segments: [{ start: 15, end: 45, vector: [...vector] }] } };
}

test("private results retain the frozen source and exact model excerpt without mutating inputs", () => {
  for (const analyzer of MODELS) {
    const f = resultFixture(analyzer), before = structuredClone(f);
    const record = validateStoredResult(f.result, f.spec, f.source);
    assert.equal(record.evidence.sourceSha256, f.source.sourceSha256);
    assert.deepEqual(record.evidence.spans, [[15, 45]]); assert.deepEqual(record.evidence.actualSpans, [[15, 45]]);
    assert.equal(record.evidence.spanToleranceSeconds, .000002);
    assert.equal(record.vector.length, 1024); assert.equal(record.vector[0], 1);
    assert.deepEqual(f, before);
  }
});

test("changed specifications, invalid vectors and changed frozen audio cannot enter the private pool", () => {
  const mutations = [
    f => { f.result.specKey = analysisSpec(MODELS[1]).key; },
    f => { f.result.revision = "changed-revision"; },
    f => { f.result.sampleRate = 16000; },
    f => { f.result.vector.pop(); },
    f => { f.result.vector[0] = Infinity; },
    f => { f.result.vector.fill(0); },
    f => { f.result.segments[0].vector = Array(f.spec.dimensions).fill(0); f.result.segments[0].vector[1] = 1; },
    f => { f.result.audioDurationSeconds = 61; },
    f => { f.result.segments[0].start = 14; },
    f => { f.result.segments.push({ start: 45, end: 60 }); },
    f => { f.source.sourceSha256 = "not-a-source-hash"; }
  ];
  for (const mutate of mutations) {
    const f = resultFixture(); mutate(f);
    assert.throws(() => validateStoredResult(f.result, f.spec, f.source), `Must reject ${mutate}`);
  }
});

test("matching corrupt source and result timelines cannot disguise invalid or unaccounted audio", () => {
  const mutations = [
    f => { f.source.spans = [[-1, 29]]; f.result.segments[0] = { start: -1, end: 29 }; },
    f => { f.source.spans = [[15, 15]]; f.result.segments[0] = { start: 15, end: 15 }; },
    f => { f.source.spans = [[50, 80]]; f.result.segments[0] = { start: 50, end: 80 }; },
    f => { f.source.spans = [[5, 45]]; f.result.segments[0] = { start: 5, end: 45 }; },
    f => { f.result.analyzedSeconds = 60; },
    f => { f.result.sourceCoverage = 1; },
    f => { f.source.durationSeconds = f.result.audioDurationSeconds = -1; },
    f => { f.source.spans = [[15]]; }
  ];
  for (const mutate of mutations) {
    const f = resultFixture(); mutate(f);
    assert.throws(() => validateStoredResult(f.result, f.spec, f.source), `Must reject ${mutate}`);
  }
});

test("private inference receipts bind source snapshots, audio hashes and exact analyzer outputs", () => {
  for (const analyzer of MODELS) {
    const f = resultFixture(analyzer), before = structuredClone(f), receipt = createPrivateResultReceipt(f.result, f.spec, f.source);
    assert.equal(receipt.sourceSnapshotKey, f.source.snapshotKey); assert.equal(receipt.sourceSha256, f.source.sourceSha256);
    assert.equal(receipt.specKey, f.spec.key); assert.equal(receipt.revision, f.spec.revision);
    assert.equal(receipt.resultSha256, digest(JSON.stringify(f.result)));
    assert.deepEqual(readPrivateResultReceipt(receipt, f.spec, f.source), f.result);
    assert.deepEqual(f, before);
  }
});

test("a valid same-duration receipt cannot be swapped across sources, snapshots or MERT spaces", () => {
  const f = resultFixture(), receipt = createPrivateResultReceipt(f.result, f.spec, f.source);
  for (const other of [
    { ...f.source, sourceSha256: hash("another-preview") },
    { ...f.source, snapshotKey: `sonic-source-v1-${hash("another-freeze")}` }
  ]) assert.throws(() => readPrivateResultReceipt(receipt, f.spec, other), /another|source|snapshot/i);
  assert.throws(() => readPrivateResultReceipt(receipt, analysisSpec(MODELS[1]), f.source));
  assert.throws(() => readPrivateResultReceipt(f.result, f.spec, f.source), /version|equal|undefined/i);
  const wrongHash = structuredClone(receipt); wrongHash.sourceSha256 = hash("forged-audio-hash");
  assert.throws(() => readPrivateResultReceipt(wrongHash, f.spec, f.source), /audio source/i);
  for (const snapshotKey of [undefined, "", "unbound-snapshot", `sonic-source-v1-${"z".repeat(64)}`]) {
    const unbound = { ...f.source, snapshotKey };
    assert.throws(() => createPrivateResultReceipt(f.result, f.spec, unbound), /snapshot|source/i);
    assert.throws(() => readPrivateResultReceipt({ ...receipt, sourceSnapshotKey: snapshotKey }, f.spec, unbound), /snapshot|source/i);
  }
});

test("changed cached vectors are rejected even when still finite, normalized and internally consistent", () => {
  const f = resultFixture(), receipt = structuredClone(createPrivateResultReceipt(f.result, f.spec, f.source));
  receipt.result.vector[0] = 0; receipt.result.vector[1] = 1;
  receipt.result.segments[0].vector = [...receipt.result.vector];
  // The changed embedding alone satisfies shape and pooling checks. The receipt must detect replacement.
  validateStoredResult(receipt.result, f.spec, f.source);
  assert.throws(() => readPrivateResultReceipt(receipt, f.spec, f.source), /content changed/i);
  const changedSpan = structuredClone(createPrivateResultReceipt(f.result, f.spec, f.source));
  changedSpan.result.segments[0].start = 14; changedSpan.result.segments[0].end = 44;
  changedSpan.resultSha256 = digest(JSON.stringify(changedSpan.result));
  assert.throws(() => readPrivateResultReceipt(changedSpan, f.spec, f.source), /span changed/i);
});

test("one-microsecond Python rounding preserves raw receipts and canonicalizes only validated evidence", () => {
  for (const analyzer of MODELS) {
    const f = resultFixture(analyzer);
    f.source.durationSeconds = f.result.audioDurationSeconds = 120.032653;
    f.source.spans = [[45.016327, 75.016327]];
    f.result.segments[0].start = 45.016326; f.result.segments[0].end = 75.01632599999999;
    f.result.sourceCoverage = 30 / f.source.durationSeconds;
    const before = structuredClone(f), receipt = createPrivateResultReceipt(f.result, f.spec, f.source), receiptBefore = structuredClone(receipt);
    const raw = readPrivateResultReceipt(receipt, f.spec, f.source), record = validateStoredResult(raw, f.spec, f.source);
    assert.deepEqual(record.evidence.spans, f.source.spans);
    assert.deepEqual(record.evidence.actualSpans, [[45.016326, 75.01632599999999]]);
    assert.notStrictEqual(record.evidence.spans[0], f.source.spans[0]);
    assert.deepEqual(f, before); assert.deepEqual(receipt, receiptBefore);
    assert.equal(receipt.resultSha256, digest(JSON.stringify(raw)));
    for (const drift of [.0000021, .000003, .0001]) {
      const changed = structuredClone(f);
      changed.result.segments[0].start = f.source.spans[0][0] + drift;
      changed.result.segments[0].end = f.source.spans[0][1] + drift;
      assert.throws(() => validateStoredResult(changed.result, changed.spec, changed.source), /span changed/i);
    }
  }
});

test("unjudged additions and uncertain labels do not inflate or dilute observed keep rates", () => {
  const candidates = ["kept", "wrong", "skip", "uncertain", "new"].map(identityKey => ({ track: { identityKey } }));
  const labels = new Map([["kept", "KEEP"], ["wrong", "WRONG_LANE"], ["skip", "SKIP"], ["uncertain", "UNSURE"]]);
  const before = structuredClone(candidates), summary = grade(candidates, labels);
  assert.deepEqual(summary, { returned: 5, kept: 1, wrongLane: 1, skipped: 1, unsure: 1, unjudged: 1,
    judged: 3, keepRateAmongJudged: 1 / 3 });
  assert.deepEqual(candidates, before);
  assert.equal(grade(candidates, new Map()).keepRateAmongJudged, null);
  assert.equal(grade([], labels).keepRateAmongJudged, null);
});

function snapshotFixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE sonic_blind_review_batch(batch_id TEXT,private_plan_json TEXT);
    CREATE TABLE sonic_review_session_item(session_id TEXT,item_index INTEGER,candidate_identity_key TEXT,status TEXT,review_json TEXT);
    CREATE TABLE sonic_analysis_pilot(created_at TEXT,manifest_json TEXT);
    CREATE TABLE sonic_analysis_link(identity_key TEXT,spec_key TEXT,artifact_key TEXT);
    CREATE TABLE sonic_analysis_artifact(artifact_key TEXT,spec_key TEXT,source_sha256 TEXT,result_json TEXT);
    CREATE TABLE track_sonic_profile(identity_key TEXT,model TEXT,model_version TEXT,embedding_base64 TEXT,dimensions INTEGER,source_sha256 TEXT);`);
  const genres = ["Progressive House", "Trance (Main Floor)", "Psy-Trance", "House", "Techno", "Electronica"];
  const manifest = { createdAt: "2026-09-26T00:16:34.864Z", items: Array.from({ length: 200 }, (_, i) => {
    const track = { identityKey: `tidal:${i + 1}`, tidalId: String(i + 1), artist: `Artist ${i}`,
      title: `Recording ${i}`, mixVersion: "Original Mix", genre: genres[i % genres.length],
      analysisLocal: { sha256: hash(i), file: `Z:\\private-fixture-${i}.flac` } };
    return { track, recordingGroup: recordingGroup(track) };
  }) };
  db.prepare("INSERT INTO sonic_analysis_pilot VALUES(?,?)").run("2026-09-26T00:00:00Z", JSON.stringify(manifest));
  for (const analyzer of MODELS) {
    const spec = analysisSpec(analyzer), vector = Array(spec.dimensions).fill(0); vector[0] = 1;
    for (const item of manifest.items) {
      const key = `${analyzer}:${item.track.identityKey}`, source = item.track.analysisLocal.sha256;
      db.prepare("INSERT INTO sonic_analysis_artifact VALUES(?,?,?,?)").run(key, spec.key, source,
        JSON.stringify({ specKey: spec.key, revision: spec.revision, sampleRate: spec.sampleRate, segments: [{ start: 15, end: 45 }] }));
      db.prepare("INSERT INTO sonic_analysis_link VALUES(?,?,?)").run(item.track.identityKey, spec.key, key);
      db.prepare("INSERT INTO track_sonic_profile VALUES(?,?,?,?,?,?)").run(item.track.identityKey, spec.repo, spec.key,
        encodeVector(vector), spec.dimensions, source);
    }
  }
  for (const [i, batchId] of BATCHES.entries()) {
    const anchor = manifest.items[i * 2].track, candidate = manifest.items[i * 2 + 1].track;
    const sessionId = `fixture:${i}`, decision = i ? "WRONG_LANE" : "KEEP";
    // Frozen public descriptors intentionally omit available metadata.
    const publicAnchor = { identityKey: anchor.identityKey, artist: anchor.artist, title: anchor.title, mixVersion: anchor.mixVersion };
    const plan = { version: i + 1, count: 1, groups: [{ anchor: publicAnchor, sessionId, candidates: [{ track: candidate }] }],
      clips: { anchor: { sourceSha256: anchor.analysisLocal.sha256 }, candidate: { sourceSha256: candidate.analysisLocal.sha256 } },
      preparationRequest: { manifestCreatedAt: manifest.createdAt }, sourcePool: { manifestCreatedAt: manifest.createdAt } };
    db.prepare("INSERT INTO sonic_blind_review_batch VALUES(?,?)").run(batchId, JSON.stringify(plan));
    db.prepare("INSERT INTO sonic_review_session_item VALUES(?,?,?,?,?)").run(sessionId, 0, candidate.identityKey, "REVIEWED",
      JSON.stringify({ decision, reviewer: "human", listened: true }));
  }
  db.exec("PRAGMA query_only=ON");
  const change = fn => { db.exec("PRAGMA query_only=OFF"); try { fn(); } finally { db.exec("PRAGMA query_only=ON"); } };
  const state = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) =>
    [name, hash(JSON.stringify(db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()))]);
  return { db, manifest, change, state };
}

test("development snapshot reads frozen rows under query_only and reserves unexposed held-out groups", t => {
  const f = snapshotFixture(t), before = f.state(), snapshot = readDevelopmentSnapshot(f.db);
  assert.deepEqual(f.state(), before); assert.equal(snapshot.exposure.pairs, 3); assert.equal(snapshot.exposure.anchorCount, 3);
  assert.equal(snapshot.heldOut.length, 6);
  for (const track of snapshot.heldOut) {
    assert.ok(!snapshot.exposure.identities.includes(track.identityKey));
    assert.ok(!snapshot.exposure.recordingGroups.includes(recordingGroup(track)));
    const source = f.manifest.items.find(item => item.track.identityKey === track.identityKey).track.analysisLocal.sha256;
    assert.ok(!snapshot.exposure.sourceHashes.includes(source));
  }
  assert.deepEqual(snapshot.development.map(group => group.anchor.genre), f.manifest.items.filter((_, i) => [0, 2, 4].includes(i)).map(item => item.track.genre));
  assert.throws(() => f.db.prepare("DELETE FROM sonic_review_session_item").run(), /readonly|read.only/i);
});

test("saved human reviews cannot be substituted or silently treated as completed development labels", t => {
  for (const mutate of [
    db => db.prepare("UPDATE sonic_review_session_item SET candidate_identity_key='tidal:199' WHERE session_id='fixture:0'").run(),
    db => db.prepare("UPDATE sonic_review_session_item SET status='PENDING' WHERE session_id='fixture:0'").run(),
    db => db.prepare("UPDATE sonic_review_session_item SET review_json=? WHERE session_id='fixture:0'").run(JSON.stringify({ decision: "KEEP", reviewer: "assistant", listened: true }))
  ]) {
    const f = snapshotFixture(t); f.change(() => mutate(f.db));
    const before = f.state(); assert.throws(() => readDevelopmentSnapshot(f.db)); assert.deepEqual(f.state(), before);
  }
});

test("development refuses stale source profiles and cross-model excerpt drift", t => {
  const stale = snapshotFixture(t), spec = analysisSpec(MODELS[0]);
  stale.change(() => stale.db.prepare("UPDATE track_sonic_profile SET source_sha256=? WHERE identity_key='tidal:20' AND model_version=?").run(hash("changed"), spec.key));
  assert.throws(() => readDevelopmentSnapshot(stale.db), /coverage|source|evidence/i);
  const drift = snapshotFixture(t), second = analysisSpec(MODELS[1]);
  drift.change(() => drift.db.prepare("UPDATE sonic_analysis_artifact SET result_json=? WHERE artifact_key=?").run(
    JSON.stringify({ specKey: second.key, revision: second.revision, sampleRate: second.sampleRate, segments: [{ start: 16, end: 46 }] }), `${MODELS[1]}:tidal:20`));
  assert.throws(() => readDevelopmentSnapshot(drift.db), /span|excerpt|matched|provenance/i);
});

test("another latest 200-track pilot cannot replace the reviewed frozen development source", t => {
  const f = snapshotFixture(t), alternate = structuredClone(f.manifest); alternate.createdAt = "different-latest-pilot";
  alternate.items[0].track.title = "Silently substituted descriptor";
  f.change(() => f.db.prepare("INSERT INTO sonic_analysis_pilot VALUES(?,?)").run("2026-10-07T00:00:00Z", JSON.stringify(alternate)));
  let snapshot, failure;
  try { snapshot = readDevelopmentSnapshot(f.db); } catch (error) { failure = error; }
  if (failure) assert.match(failure.message, /pilot|frozen|source|manifest/i);
  else {
    assert.equal(snapshot.manifest.createdAt, f.manifest.createdAt);
    assert.notEqual(snapshot.manifest.items[0].track.title, alternate.items[0].track.title);
  }
});

test("per-model replay retains final-three caps and all fresh held-out picks remain unjudged", t => {
  const f = snapshotFixture(t), snapshot = readDevelopmentSnapshot(f.db), before = structuredClone(snapshot), rows = f.state();
  const report = evaluateAnchorExperiment(snapshot);
  assert.deepEqual(snapshot, before); assert.deepEqual(f.state(), rows);
  assert.equal(report.productionApplied, false); assert.equal(report.sourcePool.count, 200);
  assert.equal(report.sourcePool.newJointlyEncoded, 0); assert.equal(report.heldOut.length, 6);
  for (const group of [...report.development, ...report.heldOut]) {
    assert.deepEqual(group.models.map(model => model.analyzer), MODELS);
    for (const model of group.models) {
      assert.equal(model.baseline.length, 3); assert.equal(model.fitted.shortlist.length, 3);
      assert.ok(model.fitted.retrievedCandidates.length <= 30); assert.equal(model.fitted.diagnostics.reviewLabelsUsed, false);
      if (group.split === "held-out-unjudged") {
        assert.equal(model.fitLabels.judged, 0); assert.equal(model.fitLabels.unjudged, 3);
        assert.equal(model.fitLabels.kept, 0); assert.equal(model.fitLabels.keepRateAmongJudged, null);
      }
    }
  }
});

test("changing saved judgments changes development labels without changing raw retrieval or anchor-fit scores", t => {
  const f = snapshotFixture(t), others = Array(1024).fill(0); others[0] = .8; others[1] = .6;
  const nearest = Array(1024).fill(0); nearest[0] = 1;
  f.change(() => {
    f.db.prepare("UPDATE track_sonic_profile SET embedding_base64=?").run(encodeVector(others));
    f.db.prepare("UPDATE track_sonic_profile SET embedding_base64=? WHERE identity_key IN ('tidal:1','tidal:2')").run(encodeVector(nearest));
  });
  const first = evaluateAnchorExperiment(readDevelopmentSnapshot(f.db));
  f.change(() => f.db.prepare("UPDATE sonic_review_session_item SET review_json=?").run(JSON.stringify({ decision: "WRONG_LANE", reviewer: "human", listened: true })));
  const second = evaluateAnchorExperiment(readDevelopmentSnapshot(f.db));
  const ranks = report => [...report.development, ...report.heldOut].map(group => group.models.map(model => ({
    analyzer: model.analyzer, baseline: model.baseline,
    retrieved: model.fitted.retrievedCandidates.map(row => ({ identityKey: row.track.identityKey, rank: row.rank, similarity: row.similarity, fitScore: row.fitScore })),
    shortlist: model.fitted.shortlist.map(row => row.track.identityKey)
  })));
  assert.deepEqual(ranks(first), ranks(second));
  for (let i = 0; i < MODELS.length; i++) {
    assert.equal(first.development[0].models[i].fitLabels.kept, 1);
    assert.equal(second.development[0].models[i].fitLabels.kept, 0);
    assert.equal(second.development[0].models[i].fitLabels.wrongLane, 1);
  }
});

test("experiment CLI parses only explicit bounded stages and keeps artifacts inside private data", () => {
  assert.deepEqual(argumentsFor(["prepare", "--output", "data/fresh-experiment", "--supply", "data/private-supply.json"]),
    { command: "prepare", "--output": "data/fresh-experiment", "--supply": "data/private-supply.json" });
  for (const args of [[], ["start", "--output", "data/x"], ["init"], ["init", "--output"],
    ["analyze", "--output", "--supply"], ["evaluate", "--output", "data/x", "--output", "data/y"],
    ["prepare", "--output", "data/x", "--top-k", "999"]]) assert.throws(() => argumentsFor(args));
  for (const value of ["data", ".", "../outside-experiment", "data/../../outside-experiment"])
    assert.throws(() => privateDirectory(value), /private|data/i);
  assert.match(privateDirectory("data/fresh-test-experiment/nested"), /data[\\/]fresh-test-experiment[\\/]nested$/);
});

test("the readable report discloses unknown outcomes and cannot claim development keep rates prove improvement", () => {
  const report = { sourcePool: { count: 224, originalLocal: 200, newJointlyEncoded: 24 }, development: [{
    anchor: { artist: "Fixture artist", title: "Fixture anchor" }, models: [{ analyzer: MODELS[0],
      baselineLabels: { kept: 1, judged: 2, unjudged: 1 }, fitLabels: { kept: 1, judged: 1, unjudged: 2 } }]
  }], limitations: ["No held-out human judgments exist."] };
  const text = markdown(report);
  assert.match(text, /Unknown picks remain unjudged/);
  assert.match(text, /cannot establish improvement/);
  assert.match(text, /1 \/ 2 \/ 1 \| 1 \/ 1 \/ 2/);
  assert.match(text, /fresh blind listening is required/i);
});
