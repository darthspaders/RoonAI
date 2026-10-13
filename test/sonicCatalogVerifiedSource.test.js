"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const source = require("../src/sonicCatalogVerifiedSource"), original = require("../src/sonicCandidateCorpus");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { createPrivateResultReceipt } = require("../src/sonicAnchorExperiment");
const clone = value => structuredClone(value), hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function fixture(which = "mython") {
  const alt = which === "altinbas";
  const track = { identityKey: alt ? "tidal:558102742" : "tidal:511278516", tidalId: alt ? "558102742" : "511278516",
    artist: alt ? "Altinbas" : "Mython", title: alt ? "Charming the Cosmic Snake" : "Translate",
    album: alt ? "Beyond the Veil" : "Hertsmere Road EP", isrc: alt ? "DEU672600770" : "NL3M12517640",
    durationMs: alt ? 382000 : 318000, label: alt ? "Ostgut Ton" : "Planet Rhythm", year: alt ? 2026 : 2025,
    releaseDate: alt ? "2026-09-25" : "2026-05-08" };
  const provider = { id: alt ? "30463675" : "28289776", artist: track.artist, title: track.title, mixName: "Original Mix",
    album: track.album, isrc: track.isrc, durationMs: alt ? 381617 : 317624, label: track.label, releaseDate: track.releaseDate };
  const input = { track, sourceTrack: provider, sourceType: "beatport-preview", allowVersionProxy: false,
    durationSeconds: 120.032653, audioBytes: Buffer.from("synthetic original preview " + which) };
  return { track, provider, input };
}
function resultFor(spec, snapshot) {
  const vector = Array.from({ length: spec.dimensions }, (_, i) => i === 0 ? 1 : 0), [start, end] = snapshot.spans[0];
  return { specKey: spec.key, revision: spec.revision, sampleRate: spec.sampleRate, vector,
    segments: [{ start, end, vector: [...vector] }], audioDurationSeconds: snapshot.durationSeconds,
    analyzedSeconds: end - start, sourceCoverage: (end - start) / snapshot.durationSeconds };
}
function resign(snapshot) {
  const { snapshotKey, ...body } = snapshot; snapshot.snapshotKey = "sonic-source-v2-" + hash(JSON.stringify(canonical(body))); return snapshot;
}
test("recorded Mython and Altinbas diagnostics freeze honest equivalent sources with hashed proof", () => {
  for (const [name, delta] of [["mython", 376], ["altinbas", 383]]) {
    const f = fixture(name), before = clone(f.input), admission = source.admissionFor(f.track, f.provider);
    assert.equal(admission.accepted, true); assert.equal(admission.version, 2); assert.equal(admission.identityRelation, "equivalent-recording");
    assert.equal(admission.proof.durationDeltaMs, delta); assert.equal(admission.proof.relation, "ORIGINAL_EQUIVALENT_TO_UNLABELED");
    const snapshot = source.freezeSonicSourceSnapshot(f.input);
    assert.equal(snapshot.version, 2); assert.equal(snapshot.identityRelation, "equivalent-recording"); assert.equal(snapshot.allowVersionProxy, false);
    assert.match(snapshot.snapshotKey, /^sonic-source-v2-[a-f0-9]{64}$/); assert.deepEqual(snapshot.equivalenceProof, admission.proof);
    assert.deepEqual(snapshot.canonicalTrack, f.track); assert.deepEqual(snapshot.sourceTrack, f.provider);
    assert.deepEqual(snapshot.spans, [[45.016327, 75.016327]]); assert.equal(snapshot.sourceSha256, hash(f.input.audioBytes));
    assert.equal(source.assertSonicSourceSnapshot(snapshot, { track: f.track, audioBytes: f.input.audioBytes }), true);
    assert.deepEqual(clone(f.input), before); assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.equivalenceProof));
    assert.throws(() => original.assertSonicSourceSnapshot(snapshot, { track: f.track }));
  }
});
test("strict exact v1 and verified local snapshots retain byte-identical original implementation", () => {
  const f = fixture(); f.track.mixVersion = "Original Mix";
  assert.equal(source.admissionFor(f.track, f.provider).version, 1);
  assert.deepEqual(source.freezeSonicSourceSnapshot(f.input), original.freezeSonicSourceSnapshot(f.input));
  const exact = source.freezeSonicSourceSnapshot(f.input);
  assert.equal(source.assertSonicSourceSnapshot(exact, { track: f.track, audioBytes: f.input.audioBytes }), true);
  const local = { track: f.track, sourceType: "verified-local-file", audioBytes: f.input.audioBytes, durationSeconds: 120,
    localFileId: "fixture:1", linkStatus: "EXACT" };
  assert.deepEqual(source.freezeSonicSourceSnapshot(local), original.freezeSonicSourceSnapshot(local));
  const spec = analysisSpec("mert-30s"), result = resultFor(spec, exact);
  assert.deepEqual(source.createVerifiedResultReceipt(result, spec, exact), createPrivateResultReceipt(result, spec, exact));
});
test("equivalence fails closed for missing independent proof fields and conflicts", () => {
  const mutations = [
    f => { delete f.track.isrc; }, f => { delete f.provider.isrc; }, f => { f.provider.isrc = "USAAA2600001"; },
    f => { delete f.track.durationMs; }, f => { delete f.provider.durationMs; }, f => { f.provider.durationMs = f.track.durationMs - 1001; },
    f => { f.provider.album = "Unrelated compilation"; }, f => { delete f.track.album; }, f => { delete f.provider.album; },
    f => { f.provider.label = "Other label"; }, f => { delete f.track.label; }, f => { delete f.provider.label; },
    f => { f.provider.releaseDate = "2026-05-09"; }, f => { delete f.track.releaseDate; }, f => { delete f.provider.releaseDate; },
    f => { f.provider.releaseDate = "2026-02-30"; f.track.releaseDate = "2026-02-30"; },
    f => { f.provider.releaseDate = "2026/05/08"; f.track.releaseDate = "2026/05/08"; },
    f => { f.provider.artist = "Mython, Guest"; }, f => { f.track.artist = "Mython, Guest"; },
    f => { f.provider.artist = "Alias"; f.track.artistAliases = ["Alias"]; },
    f => { f.track.artists = [{ name: "Mython" }, { name: "Guest" }]; },
    f => { f.provider.artists = [{ name: "Mython" }, { name: "Guest" }]; },
    f => { f.provider.artist = "My thon"; }, f => { f.provider.title = "Different title"; },
    f => { f.track.beatportTrackId = "999"; }
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f); assert.equal(source.admissionFor(f.track, f.provider).accepted, false);
    assert.throws(() => source.freezeSonicSourceSnapshot(f.input));
  }
});
test("full named artist sets can be reordered without aliases and the one-second duration boundary is inclusive", () => {
  const f = fixture(); f.track.artist = "Mython, Guest"; f.provider.artist = "Guest & Mython";
  f.track.artists = [{ name: "Guest" }, { name: "Mython" }]; f.provider.artists = [{ name: "Mython" }, { name: "Guest" }];
  f.provider.durationMs = f.track.durationMs - 1000;
  const admission = source.admissionFor(f.track, f.provider); assert.equal(admission.accepted, true); assert.equal(admission.version, 2);
  assert.deepEqual(admission.proof.artistCredits, ["guest", "mython"]); assert.equal(admission.proof.durationDeltaMs, 1000);
  const snapshot = source.freezeSonicSourceSnapshot(f.input); assert.equal(source.assertSonicSourceSnapshot(snapshot, { track: f.track }), true);
});
test("explicit alternate versions and conflicting version fields never become Original proof", () => {
  for (const mix of ["Extended Mix", "Radio Edit", "Named Remix", "Original Extended Mix", "Someone Original Mix", "Main Mix", "DJ Mixed", "Dub Mix"]) {
    const f = fixture(); f.provider.mixName = mix; assert.equal(source.admissionFor(f.track, f.provider).accepted, false, mix);
  }
  for (const field of ["mixVersion", "version", "remix"]) {
    const f = fixture(); f.provider[field] = "Named Remix"; assert.equal(source.admissionFor(f.track, f.provider).accepted, false, field);
    const target = fixture(); target.track[field] = "Unknown Edition"; assert.equal(source.admissionFor(target.track, target.provider).accepted, false);
  }
  const hidden = fixture(); hidden.provider.title += " (Radio Edit)";
  assert.equal(source.admissionFor(hidden.track, hidden.provider).accepted, false);
});
test("contradictory explicit canonical and source IDs are independently rejected", () => {
  for (const key of ["id", "tidalId", "tidalTrackId", "trackId", "track_id"]) {
    const f = fixture(); f.track[key] = "999"; assert.equal(source.admissionFor(f.track, f.provider).accepted, false, key);
    const nested = fixture(); nested.track.tidal = { [key]: "999" }; assert.equal(source.admissionFor(nested.track, nested.provider).accepted, false);
  }
  for (const key of ["tidalUrl", "tidal_url", "url"]) {
    const f = fixture(); f.track[key] = "https://tidal.com/browse/track/999"; assert.equal(source.admissionFor(f.track, f.provider).accepted, false);
  }
  for (const key of ["trackId", "track_id", "beatportTrackId", "beatportId"]) {
    const f = fixture(); f.provider[key] = "999"; assert.equal(source.admissionFor(f.track, f.provider).accepted, false);
  }
  const raw = fixture(); raw.provider.rawJson = { id: "999" }; assert.equal(source.admissionFor(raw.track, raw.provider).accepted, false);
});
test("new strict exact admission refuses ISRC conflicts even when the old freeze permits them", () => {
  const f = fixture(); f.track.mixVersion = "Original Mix"; f.provider.isrc = "USAAA2600001";
  assert.doesNotThrow(() => original.freezeSonicSourceSnapshot(f.input));
  assert.equal(source.admissionFor(f.track, f.provider).accepted, false);
  assert.throws(() => source.freezeSonicSourceSnapshot(f.input));
  const saved = original.freezeSonicSourceSnapshot(f.input);
  assert.equal(source.assertSonicSourceSnapshot(saved, { track: f.track }), true);
});
test("proof, source fields and canonical metadata cannot be altered even with a recomputed body key", () => {
  const f = fixture(), snapshot = source.freezeSonicSourceSnapshot(f.input);
  const mutations = [s => { s.equivalenceProof.durationDeltaMs = 0; }, s => { s.equivalenceProof.tidal.matched = false; },
    s => { s.equivalenceProof.extra = "unsafe"; }, s => { s.identityRelation = "exact"; }, s => { s.allowVersionProxy = true; },
    s => { s.canonicalTrack.label = "Other label"; }, s => { s.sourceTrack.releaseDate = "2026-05-09"; },
    s => { s.sourceTrack.id = "999"; }, s => { s.sourceTrack.mixVersion = "Named Remix"; },
    s => { s.spans[0][0] += .01; }, s => { s.spans[0][1] += .01; }, s => { s.sourceTrack.extra = "invented"; },
    s => { s.extra = true; }, s => { s.recordingDescriptor.title = "Other title"; }, s => { s.canonicalTrackId = "999"; }];
  for (const mutate of mutations) {
    const changed = clone(snapshot); mutate(changed); resign(changed);
    assert.throws(() => source.assertSonicSourceSnapshot(changed, { track: f.track, audioBytes: f.input.audioBytes }));
  }
  assert.throws(() => source.assertSonicSourceSnapshot(snapshot, { track: { ...f.track, title: "Other title" } }));
  assert.throws(() => source.assertSonicSourceSnapshot(snapshot, { track: f.track, audioBytes: Buffer.from("changed original bytes") }));
});
test("bounded original bytes and exact full centered span are required", () => {
  for (const durationSeconds of [29.999, 7200.1, NaN, Infinity]) {
    const f = fixture(); assert.throws(() => source.freezeSonicSourceSnapshot({ ...f.input, durationSeconds }));
  }
  const f = fixture();
  assert.throws(() => source.freezeSonicSourceSnapshot({ ...f.input, audioBytes: Buffer.alloc(0) }));
  assert.throws(() => source.freezeSonicSourceSnapshot({ ...f.input, audioBytes: Buffer.alloc(source.MAX_SOURCE_BYTES + 1) }));
  assert.throws(() => source.freezeSonicSourceSnapshot({ ...f.input, spans: [[0, 30]] }));
  assert.throws(() => source.freezeSonicSourceSnapshot({ ...f.input, localFileId: "1" }));
  assert.throws(() => source.freezeSonicSourceSnapshot({ ...f.input, allowVersionProxy: true }));
});
test("typed v2-source results preserve distinct exact MERT specifications and worker provenance", () => {
  const f = fixture(), snapshot = source.freezeSonicSourceSnapshot(f.input);
  for (const analyzer of ["mert-fullsong", "mert-30s"]) {
    const spec = analysisSpec(analyzer), result = resultFor(spec, snapshot), receipt = source.createVerifiedResultReceipt(result, spec, snapshot);
    assert.equal(receipt.version, 1); assert.equal(receipt.sourceSnapshotKey, snapshot.snapshotKey);
    assert.deepEqual(source.readVerifiedResultReceipt(receipt, spec, snapshot), result);
    const rawPrecision = clone(result); rawPrecision.segments[0].start -= .000001; rawPrecision.segments[0].end -= .000001;
    assert.doesNotThrow(() => source.createVerifiedResultReceipt(rawPrecision, spec, snapshot));
    for (const mutate of [r => { r.sourceSnapshotKey = "sonic-source-v1-" + "0".repeat(64); }, r => { r.sourceSha256 = "0".repeat(64); },
      r => { r.result.vector[0] = 2; }, r => { r.extra = true; }]) {
      const changed = clone(receipt); mutate(changed); assert.throws(() => source.readVerifiedResultReceipt(changed, spec, snapshot));
    }
    const wrongSpan = clone(result); wrongSpan.segments[0].start += .01;
    assert.throws(() => source.createVerifiedResultReceipt(wrongSpan, spec, snapshot));
    const changedSpec = clone(spec); changedSpec.repo = "invented/repository";
    assert.throws(() => source.createVerifiedResultReceipt(result, changedSpec, snapshot));
    assert.throws(() => source.readVerifiedResultReceipt(receipt, analysisSpec(analyzer === "mert-30s" ? "mert-fullsong" : "mert-30s"), snapshot));
  }
});
