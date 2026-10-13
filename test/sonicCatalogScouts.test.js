"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { freezeSonicSourceSnapshot } = require("../src/sonicCandidateCorpus");
const { MODELS, freezeSonicCatalogScoutPool, buildSonicCatalogScouts, evaluateSonicCatalogScouts } = require("../src/sonicCatalogScouts");
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");
function item(id, overrides = {}, audio = `source-${id}`) {
  const track = { identityKey: `tidal:${id}`, tidalId: String(id), artist: "Exact catalog artist", title: `Recording ${id}`,
    mixVersion: "Original Mix", durationMs: 420000, isrc: `USABC26${String(id).padStart(5, "0")}`, genre: "Frozen catalog tag",
    label: "Verified label", year: 2021, releaseDate: "2021-04-11", releaseEvidence: { trackYear: 2021, trackDate: "2021-04-11" }, ...overrides };
  const source = freezeSonicSourceSnapshot({ track, sourceType: "beatport-preview", audioBytes: Buffer.from(audio), durationSeconds: 120,
    sourceTrack: { id: String(id + 1000), artist: track.artist, title: track.title, mixName: track.mixVersion, durationMs: track.durationMs, isrc: track.isrc }, allowVersionProxy: false });
  return { track, source, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: clone(track) } };
}
function vector(x = 1, y = 0) { return [x, y, ...Array(1022).fill(0)]; }
function record(value, analyzer, xy) {
  const spec = analysisSpec(analyzer);
  return { identityKey: value.track.identityKey, analyzer, repo: spec.repo, specKey: spec.key, revision: spec.revision,
    sampleRate: spec.sampleRate, dimensions: spec.dimensions, sourceSnapshotKey: value.source.snapshotKey,
    sourceSha256: value.source.sourceSha256, spans: clone(value.source.spans), vector: vector(...xy) };
}
function fixture(extra = {}) {
  const anchor = item(1), items = [item(10), item(11), item(12), item(13)];
  const rankings = [[.9, .1], [.4, .9], [.8, .6], [.2, .4]];
  const matrices = new Map(MODELS.map((analyzer, index) => [analyzer, { spec: analysisSpec(analyzer),
    records: new Map([[anchor.track.identityKey, record(anchor, analyzer, index ? [0, 1] : [1, 0])],
      ...items.map((value, i) => [value.track.identityKey, record(value, analyzer, rankings[i])])]) }]));
  return { anchor, pool: freezeSonicCatalogScoutPool({ items }), matrices, mode: "observe", ...extra };
}
const identities = result => result.scouts.map(track => track.identityKey);
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

test("catalog scouts rank each pinned model independently and preserve canonical discovery metadata", () => {
  const data = fixture({ selector: "mert-fullsong" }), full = buildSonicCatalogScouts(data), short = buildSonicCatalogScouts({ ...data, selector: "mert-30s" });
  assert.deepEqual(identities(full), ["tidal:10", "tidal:12", "tidal:13", "tidal:11"]);
  assert.deepEqual(identities(short), ["tidal:11", "tidal:13", "tidal:12", "tidal:10"]);
  assert.equal(full.scouts[0].sonicScout.nominations[0].analyzer, "mert-fullsong");
  assert.ok(Math.abs(full.scouts[0].sonicScout.nominations[0].similarity - .9 / Math.hypot(.9, .1)) < 1e-12);
  assert.equal(full.scouts[0].label, "Verified label"); assert.equal(full.scouts[0].year, 2021);
  assert.deepEqual(full.scouts[0].releaseEvidence, { trackYear: 2021, trackDate: "2021-04-11" });
  assert.equal(full.diagnostics.vectorSpacesMixed, false); assert.equal(full.productionApplied, false); assert.equal(full.queueable, false);
});

test("ensemble uses ranks, defaults to zero agreement and bounds the scout union", () => {
  const result = buildSonicCatalogScouts(fixture({ selector: "ensemble", scoutCount: 3 }));
  assert.deepEqual(identities(result), ["tidal:10", "tidal:11", "tidal:12"]);
  assert.equal(result.scouts.length, 3);
  assert.ok(result.scouts.every(track => track.sonicScout.agreementBonus === 0));
  const boosted = buildSonicCatalogScouts(fixture({ selector: "ensemble", scoutCount: 3, agreementWeight: .05 }));
  assert.equal(boosted.scouts[2].sonicScout.agreementBonus, .05);
  assert.ok(boosted.scouts.every(track => track.sonicScout.agreementBonus <= .1));
  const changed = fixture({ selector: "ensemble", scoutCount: 3 });
  // Rescaling one model's vectors changes neither cosine ranking nor fusion.
  for (const entry of changed.matrices.get(MODELS[0]).records.values()) entry.vector = entry.vector.map(x => x * 1000);
  assert.deepEqual(identities(buildSonicCatalogScouts(changed)), identities(result));
});

test("off is the neutral default and never invokes the discovery finalizer", () => {
  const result = evaluateSonicCatalogScouts({}, { finalizeCandidates() { throw new Error("must not run"); } });
  assert.deepEqual(result.scouts, []); assert.equal(result.mode, "off"); assert.equal(result.scoutCount, 6);
  assert.equal(result.diagnostics.neutral, true); assert.equal(result.diagnostics.fallback, true); assert.equal(result.finalized, null);
});

test("missing coverage is neutral with an explicit single-model fallback and no zero-filled candidates", () => {
  const data = fixture({ selector: "ensemble" }); data.matrices.delete(MODELS[1]);
  const result = buildSonicCatalogScouts(data);
  assert.deepEqual(identities(result), ["tidal:10", "tidal:12", "tidal:13", "tidal:11"]);
  assert.equal(result.diagnostics.singleModelFallback, true); assert.equal(result.diagnostics.partialCoverage, true);
  assert.equal(result.diagnostics.fallback, true); assert.equal(result.diagnostics.missingCoverageIsNegative, false);
  assert.ok(result.scouts.every(track => track.sonicScout.nominations.length === 1 && track.sonicScout.agreementBonus === 0));
  const unavailable = buildSonicCatalogScouts({ ...data, selector: "mert-30s" });
  assert.deepEqual(unavailable.scouts, []); assert.equal(unavailable.diagnostics.fallback, true); assert.equal(unavailable.diagnostics.neutral, true);
  data.matrices.get(MODELS[0]).records.delete("tidal:10");
  assert.ok(!identities(buildSonicCatalogScouts(data)).includes("tidal:10"));
});

test("self identity, recording and original source cannot become scouts", () => {
  const data = fixture(), alias = item(15, { title: data.anchor.track.title, isrc: data.anchor.track.isrc }, "anchor-alias-preview");
  const shared = item(16, { title: data.anchor.track.title, isrc: data.anchor.track.isrc }, "source-1");
  data.pool = freezeSonicCatalogScoutPool({ items: [data.anchor, alias, shared, ...data.pool.items] });
  for (const analyzer of MODELS) for (const value of [alias, shared]) data.matrices.get(analyzer).records.set(value.track.identityKey, record(value, analyzer, [1, 1]));
  // The pool deduplicates the aliases before ranking; their cache rows are not part of the canonical pool.
  for (const matrix of data.matrices.values()) for (const key of [...matrix.records.keys()])
    if (key !== data.anchor.track.identityKey && !data.pool.items.some(value => value.track.identityKey === key)) matrix.records.delete(key);
  const result = buildSonicCatalogScouts(data);
  assert.ok(identities(result).every(key => !["tidal:1", "tidal:15", "tidal:16"].includes(key)));
  assert.equal(result.diagnostics.excludedSelfCount, 1);
});

test("an explicitly different remix survives even when catalog ISRC metadata is shared", () => {
  const data = fixture(), remix = item(17, { title: "Recording 1 (Named Artist Remix)", mixVersion: "Named Artist Remix", isrc: data.anchor.track.isrc });
  data.pool = freezeSonicCatalogScoutPool({ items: [remix, ...data.pool.items] });
  for (const analyzer of MODELS) data.matrices.get(analyzer).records.set(remix.track.identityKey, record(remix, analyzer, [1, 1]));
  assert.ok(identities(buildSonicCatalogScouts(data)).includes("tidal:17"));
});

test("exact aliases deduplicate while explicit named remixes remain separate", () => {
  const original = item(10), duplicate = clone(original), alias = item(11, { title: original.track.title, isrc: original.track.isrc }),
    remix = item(12, { title: "Recording 10 (Named Artist Remix)", mixVersion: "Named Artist Remix" });
  const pool = freezeSonicCatalogScoutPool({ items: [remix, alias, duplicate, original] });
  assert.deepEqual(pool.items.map(value => value.track.identityKey), ["tidal:10", "tidal:12"]);
  assert.equal(pool.diagnostics.duplicates.length, 2); assert.equal(pool.items[1].track.mixVersion, "Named Artist Remix");
  assert.throws(() => freezeSonicCatalogScoutPool({ items: [original, item(12, { title: remix.track.title, mixVersion: remix.track.mixVersion }, "source-10")] }), /conflicting versions/);
  assert.throws(() => freezeSonicCatalogScoutPool({ items: [original, item(10, {}, "changed-source")] }), /Conflicting frozen/);
});

test("unverified identity, named-version or frozen pool tampering fails closed", () => {
  for (const alter of [value => { value.verification.verified = false; }, value => { value.track.tidalId = "999"; },
    value => { value.track.mixVersion = "Different Remix"; }, value => { value.source.sourceSha256 = hash("changed"); }]) {
    const value = clone(item(10)); alter(value);
    assert.throws(() => freezeSonicCatalogScoutPool({ items: [value] }), /verified|canonical|source|snapshot|conflict/i);
  }
  const data = fixture(); data.pool = clone(data.pool); data.pool.items[0].track.label = "Changed ranking metadata";
  assert.throws(() => buildSonicCatalogScouts(data), /pool changed/);
  const order = fixture(); order.pool = clone(order.pool); order.pool.items.reverse();
  assert.throws(() => buildSonicCatalogScouts(order), /order|descriptors/);
});

test("cross-model repository, specification, hash and excerpt mismatches reject before ranking", () => {
  for (const change of [value => { value.repo = analysisSpec(MODELS[0]).repo; }, value => { value.specKey = analysisSpec(MODELS[0]).key; },
    value => { value.revision = "incorrect"; }, value => { value.sampleRate = 16000; }, value => { value.dimensions = 1280; },
    value => { value.sourceSha256 = hash("changed"); }, value => { value.sourceSnapshotKey += "changed"; }, value => { value.spans[0][0] += .000001; }]) {
    const data = fixture(); change(data.matrices.get(MODELS[1]).records.get("tidal:10"));
    assert.throws(() => buildSonicCatalogScouts(data), /mismatched.*provenance/);
  }
  const spec = fixture(); spec.matrices.get(MODELS[1]).spec = { ...analysisSpec(MODELS[1]), layer: 23 };
  assert.throws(() => buildSonicCatalogScouts(spec), /specification changed/);
});

test("malformed or zero embeddings and records outside the frozen pool cannot manufacture nominations", () => {
  for (const vectorValue of [Array(1024).fill(0), Array(1023).fill(1), [NaN, ...Array(1023).fill(1)], [Infinity, ...Array(1023).fill(1)]]) {
    const data = fixture(); data.matrices.get(MODELS[0]).records.get("tidal:10").vector = vectorValue;
    assert.throws(() => buildSonicCatalogScouts(data), /embedding/);
  }
  const data = fixture(); data.matrices.get(MODELS[0]).records.set("tidal:999", record(item(999), MODELS[0], [1, 0]));
  assert.throws(() => buildSonicCatalogScouts(data), /outside the frozen pool/);
});

test("the actual finalizer controls admission, taste scoring and diversity without any invented scout points", () => {
  const data = fixture({ selector: "ensemble", finalCount: 2 });
  let calls = 0;
  const result = evaluateSonicCatalogScouts(data, { finalizeCandidates(candidates, context) {
    calls++; assert.equal(context.requestedCount, 2); assert.equal(context.anchor.identityKey, "tidal:1"); assert.equal(context.selector, "ensemble");
    assert.ok(candidates.every(track => track.score === undefined && track.scoreBreakdown === undefined));
    // A shared policy may reject the top cosine pick and choose admitted diverse picks.
    candidates[0].label = "mutated callback copy";
    return { tracks: candidates.slice(1, 3).map(track => ({ ...track, score: 71 })), alternates: [],
      discarded: [{ identityKey: candidates[0].identityKey, reason: "existing-admission" }], verification: { sharedPipeline: true } };
  } });
  assert.equal(calls, 1); assert.deepEqual(result.finalized.tracks.map(track => track.identityKey), ["tidal:11", "tidal:12"]);
  assert.equal(result.scouts[0].label, "Verified label"); assert.equal(result.finalized.verification.sharedPipeline, true);
  assert.equal(result.productionApplied, false);
  assert.throws(() => evaluateSonicCatalogScouts(data), /actual shared discovery finalizer/);
  assert.throws(() => evaluateSonicCatalogScouts(data, { finalizeCandidates: () => ({ tracks: [{ identityKey: "tidal:999" }] }) }), /unknown/);
  assert.throws(() => evaluateSonicCatalogScouts(data, { finalizeCandidates: candidates => ({ tracks: [candidates[0], candidates[0]] }) }), /duplicate/);
  assert.throws(() => evaluateSonicCatalogScouts(data, { finalizeCandidates: candidates => ({ tracks: candidates }) }), /oversized/);
  assert.throws(() => evaluateSonicCatalogScouts(data, { finalizeCandidates: candidates => ({ tracks: [{ ...candidates[0], title: "Different recording" }] }) }), /changed the exact scout/);
});

test("genuine additional catalog facts survive the scout seam without becoming identity authority", () => {
  const data = fixture(), values = data.pool.items.map(value => clone(value));
  values[0].track.beatportGenre = "Psy-Trance";
  values[0].track.metadataEnrichment = { beatport: { genre: "Psy-Trance", subgenre: "Full On", source: "beatport", verifiedCatalogFact: true }, confidence: 95 };
  values[0].track.catalogExtra = { albumType: "SINGLE", originalReleaseYear: 2021 };
  data.pool = freezeSonicCatalogScoutPool({ items: values });
  const result = buildSonicCatalogScouts({ ...data, selector: "mert-fullsong" });
  assert.deepEqual(result.scouts[0].metadataEnrichment, values[0].track.metadataEnrichment);
  assert.deepEqual(result.scouts[0].catalogExtra, values[0].track.catalogExtra);
  assert.equal(result.scouts[0].beatportGenre, "Psy-Trance");
});

test("frozen input is deterministic, immutable and review/source internals never reach scouts", () => {
  const data = fixture({ selector: "ensemble" }), plainPool = clone(data.pool);
  data.anchor.track.review = { decision: "KEEP" }; data.anchor.track.sourceFile = "C:/private/anchor.audio";
  const alteredItems = data.pool.items.map(value => ({ ...clone(value), track: { ...value.track, review: { decision: "KEEP" },
    vector: [999], sourceFile: "C:/private/recording.audio", sourceSha256: value.source.sourceSha256,
    releaseEvidence: { ...value.track.releaseEvidence, review: { decision: "KEEP" }, sourceFile: "C:/private/file" } } }));
  data.pool = freezeSonicCatalogScoutPool({ items: alteredItems });
  assert.equal(data.pool.poolKey, plainPool.poolKey);
  freeze(data.anchor); freeze(data.pool); for (const matrix of data.matrices.values()) for (const value of matrix.records.values()) freeze(value);
  const before = clone({ anchor: data.anchor, pool: data.pool, records: [...data.matrices].map(([id, matrix]) => [id, [...matrix.records]]) });
  const result = buildSonicCatalogScouts(data);
  assert.deepEqual(result, buildSonicCatalogScouts(data));
  assert.deepEqual(clone({ anchor: data.anchor, pool: data.pool, records: [...data.matrices].map(([id, matrix]) => [id, [...matrix.records]]) }), before);
  const serialized = JSON.stringify(result);
  for (const fragment of ["C:/private", "sourceSha256", "snapshotKey", '"vector"', '"review"']) assert.ok(!serialized.includes(fragment), fragment);
});

test("selection and pool limits reject ambiguous configuration", () => {
  for (const options of [{ mode: "blend" }, { selector: "mert" }, { scoutCount: 0 }, { scoutCount: 21 }, { finalCount: 7 },
    { finalCount: 0 }, { selector: "ensemble", agreementWeight: .100001 }, { agreementWeight: .05 }, { ignored: true }])
    assert.throws(() => buildSonicCatalogScouts(options), /catalog scout|Catalog scout|supported/i);
  assert.throws(() => freezeSonicCatalogScoutPool({ items: Array(101).fill(item(10)) }), /at most 100/);
  const empty = fixture(); empty.pool = freezeSonicCatalogScoutPool({ items: [] });
  for (const matrix of empty.matrices.values()) matrix.records = new Map([[empty.anchor.track.identityKey, matrix.records.get(empty.anchor.track.identityKey)]]);
  const result = buildSonicCatalogScouts(empty);
  assert.equal(result.diagnostics.fallback, true); assert.equal(result.diagnostics.neutral, true);
  assert.equal(result.diagnostics.reason, "no-eligible-catalog-candidates"); assert.equal(result.diagnostics.eligiblePoolCount, 0);
  assert.equal(result.diagnostics.partialCoverage, false); assert.equal(result.diagnostics.singleModelFallback, false);
  assert.ok(result.diagnostics.missingCoverage.every(row => row.anchorAvailable && row.missingCandidateCount === 0));
  assert.deepEqual(result.scouts, []);
});
