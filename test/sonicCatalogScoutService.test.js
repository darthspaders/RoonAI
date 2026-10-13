"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { createHash } = require("node:crypto");
const { SonicCatalogScoutService, REQUIRED_CODE } = require("../src/sonicCatalogScoutService");
const { SonicCatalogScoutCache, MODELS } = require("../src/sonicCatalogScoutCache");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { freezeSonicSourceSnapshot } = require("../src/sonicCandidateCorpus");
const { createPrivateResultReceipt } = require("../src/sonicAnchorExperiment");
const ROOT = path.resolve(__dirname, ".."), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const tree = directory => fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? tree(path.join(directory, entry.name)).map(file => `${entry.name}/${file}`) : [entry.name]) : [];
function fixture(t, { warm = [], candidateCount = 7 } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sonic-scout-service-")), privateRoot = path.join(temporary, "data"), directory = path.join(privateRoot, "pilot");
  fs.mkdirSync(path.join(directory, "audio"), { recursive: true });
  t.after(() => { assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(temporary, { recursive: true, force: true }); });
  const entries = Array.from({ length: candidateCount + 1 }, (_, index) => {
    const id = 100 + index, track = { identityKey: `tidal:${id}`, tidalId: String(id), artist: "Exact artist", title: `Recording ${id}`,
      mixVersion: index === 0 ? "Known Artist Remix" : "Original Mix", durationMs: 360000, isrc: `USABC2600${id}` };
    const audioBytes = Buffer.from(`exact-source-bytes-${id}`), source = freezeSonicSourceSnapshot({ track, audioBytes, sourceType: "beatport-preview", durationSeconds: 120.032653,
      sourceTrack: { id: String(id + 1000), artist: track.artist, title: track.title, mixName: track.mixVersion, durationMs: track.durationMs, isrc: track.isrc }, allowVersionProxy: false });
    const sourceFile = path.join(directory, "audio", `${source.sourceSha256}.audio`); fs.writeFileSync(sourceFile, audioBytes);
    return { track, source, sourceFile, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: structuredClone(track) }, audioBytes };
  });
  const pool = { version: 1, kind: "catalog-scout-pilot-pool", entries: entries.map(({ audioBytes, ...entry }) => structuredClone(entry)),
    requests: [{ requestId: "frozen-request", anchorIdentityKey: entries[0].track.identityKey, candidateIdentityKeys: entries.slice(1).map(entry => entry.track.identityKey) }] };
  const request = { version: 1, recipe: { scoutCount: 6, finalCount: 3, agreementWeight: 0, productionApplied: false, models: MODELS.map(analysisSpec) } };
  write(path.join(directory, "pool.json"), pool); write(path.join(directory, "request.json"), request);
  const plan = { version: 1, productionApplied: false, models: structuredClone(MODELS.map(analysisSpec)), poolSha256: hash(fs.readFileSync(path.join(directory, "pool.json"))),
    requestSha256: hash(fs.readFileSync(path.join(directory, "request.json"))), code: { files: REQUIRED_CODE.map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(ROOT, file))) })) } };
  write(path.join(directory, "plan.json"), plan);
  const cache = new SonicCatalogScoutCache({ privateRoot, directory: path.join(directory, "cache") });
  function ingest(analyzer) {
    const spec = analysisSpec(analyzer);
    for (const [index, entry] of entries.entries()) {
      const vector = Array(spec.dimensions).fill(0); vector[0] = 1; vector[1] = index / 10;
      const result = { specKey: spec.key, revision: spec.revision, sampleRate: spec.sampleRate, vector, audioDurationSeconds: entry.source.durationSeconds,
        analyzedSeconds: 30, sourceCoverage: 30 / entry.source.durationSeconds, segments: [{ start: entry.source.spans[0][0], end: entry.source.spans[0][1], vector: [...vector] }] };
      cache.ingest({ track: entry.track, source: entry.source, audioBytes: entry.audioBytes, analyzer, receipt: createPrivateResultReceipt(result, spec, entry.source) });
    }
  }
  warm.forEach(ingest);
  const service = new SonicCatalogScoutService({ privateRoot, projectRoot: ROOT });
  return { temporary, privateRoot, directory, entries, pool, request, plan, cache, ingest, service,
    configure: (selector = "ensemble") => service.configure({ mode: "observe", selector, pilotDirectory: directory }),
    reseal() { write(path.join(directory, "pool.json"), pool); write(path.join(directory, "request.json"), request);
      plan.poolSha256 = hash(fs.readFileSync(path.join(directory, "pool.json"))); plan.requestSha256 = hash(fs.readFileSync(path.join(directory, "request.json"))); write(path.join(directory, "plan.json"), plan); } };
}
const anchorOptions = f => ({ options: { anchorTrack: f.entries[0].track } });
const liveCandidates = f => f.entries.slice(1).map(entry => structuredClone(entry.track));
function privateFree(value, f) {
  const text = JSON.stringify(value);
  for (const secret of ["tidal:", "nominations", "identityKey", "sourceSha256", "sourceFile", "Known Artist Remix", f.directory, ...f.entries.map(entry => entry.source.sourceSha256)]) assert.ok(!text.includes(secret), secret);
}

test("default off creates no control or cache files and preserves the original candidate array", t => {
  const f = fixture(t), before = tree(f.privateRoot), candidates = Object.freeze([{ identityKey: "unrelated:2" }, { title: "unchanged order" }]);
  const result = f.service.observeCandidates(candidates, { options: { get anchorTrack() { throw new Error("off must not inspect the anchor"); } } });
  assert.equal(result.candidates, candidates); assert.equal(result.diagnostics.mode, "off"); assert.equal(result.diagnostics.neutral, true);
  assert.equal(result.diagnostics.orderingChanged, false); assert.equal(result.diagnostics.inferenceStarted, false); assert.deepEqual(tree(f.privateRoot), before);
  assert.equal(fs.existsSync(path.join(f.privateRoot, "sonic-catalog-scout-config.json")), false); privateFree(result.diagnostics, f);
});
test("explicit configuration writes only its isolated control file and reloads with safe fixed limits", t => {
  const f = fixture(t), before = tree(f.privateRoot); f.configure("mert-fullsong");
  assert.deepEqual(tree(f.privateRoot).filter(file => !before.includes(file)), ["sonic-catalog-scout-config.json"]);
  const loaded = new SonicCatalogScoutService({ privateRoot: f.privateRoot, projectRoot: ROOT }), status = loaded.status();
  assert.equal(status.mode, "observe"); assert.equal(status.selector, "mert-fullsong"); assert.equal(status.scoutCount, 6); assert.equal(status.finalCount, 3); assert.equal(status.agreementWeight, 0);
  assert.equal(status.runtimeDatabaseWrites, 0); assert.equal(status.productionApplied, false); privateFree(status, f);
  loaded.configure({ mode: "off" }); assert.equal(loaded.observeCandidates([], anchorOptions(f)).diagnostics.reason, "mode-off");
});
test("configured cold evidence is neutral and reading status/observe never starts or repairs analysis", t => {
  const f = fixture(t); f.configure(); const before = tree(f.privateRoot), status = f.service.status(), actual = [{ title: "production pick" }];
  assert.equal(status.preparedPoolCount, 8); assert.equal(status.preparedRequestCount, 1); assert.equal(status.jointWarmSourceCount, 0); assert.equal(status.neutral, true);
  assert.equal(status.models[MODELS[0]].cold, 8); const observed = f.service.observeCandidates(actual, anchorOptions(f));
  assert.equal(observed.candidates, actual); assert.equal(observed.diagnostics.scoutsReturned, 0); assert.equal(observed.diagnostics.fallback, true);
  assert.equal(observed.diagnostics.missingModelIsNegative, false); assert.deepEqual(tree(f.privateRoot), before); assert.equal(fs.existsSync(path.join(f.directory, "cache")), false);
  privateFree(status, f); privateFree(observed.diagnostics, f);
});
test("both warm spaces produce at most six count-only shadow scouts without changing actual picks", t => {
  const f = fixture(t, { warm: MODELS }); f.configure(); const status = f.service.status(), actual = [{ identityKey: "tidal:999", score: 71 }, ...liveCandidates(f)], before = structuredClone(actual);
  const filesBefore = tree(f.privateRoot), observed = f.service.observeCandidates(actual, anchorOptions(f));
  assert.equal(status.cacheReady, true); assert.equal(status.jointWarmSourceCount, 8); assert.equal(status.models[MODELS[1]].warm, 8);
  assert.equal(observed.candidates, actual); assert.deepEqual(actual, before); assert.equal(observed.diagnostics.scoutsReturned, 6);
  assert.equal(observed.diagnostics.fallback, false); assert.equal(observed.diagnostics.productionApplied, false); assert.equal(observed.diagnostics.orderingChanged, false);
  assert.deepEqual(tree(f.privateRoot), filesBefore); privateFree(observed.diagnostics, f); privateFree(status, f);
});
test("one warm space remains an explicit neutral fallback and never invents the missing model", t => {
  const f = fixture(t, { warm: [MODELS[0]] }); f.configure(); const result = f.service.observeCandidates(liveCandidates(f), anchorOptions(f));
  assert.equal(result.diagnostics.scoutsReturned, 6); assert.equal(result.diagnostics.singleModelFallback, true); assert.equal(result.diagnostics.partialCoverage, true);
  assert.equal(result.diagnostics.fallback, true); assert.equal(result.diagnostics.cache[MODELS[1]].cold, 8); assert.equal(result.diagnostics.cache[MODELS[1]].warm, 0);
  f.service.configure({ selector: MODELS[1] }); const unavailable = f.service.observeCandidates(liveCandidates(f), anchorOptions(f));
  assert.equal(unavailable.diagnostics.scoutsReturned, 0); assert.equal(unavailable.diagnostics.neutral, true); privateFree(result.diagnostics, f);
});
test("warm observation requires an exact live intersection and accepts real wrapped candidates", t => {
  const f = fixture(t, { warm: MODELS }); f.configure();
  const empty = [], none = f.service.observeCandidates(empty, anchorOptions(f));
  assert.equal(none.candidates, empty); assert.equal(none.diagnostics.reason, "no-exact-live-prepared-candidates"); assert.equal(none.diagnostics.scoutsReturned, 0); assert.equal(none.diagnostics.neutral, true);
  const selected = liveCandidates(f).slice(0, 2), wrapped = selected.map(tidal => ({ tidal, score: 91, lane: "normal" }));
  wrapped.push({ tidal: { ...f.entries[3].track, mixVersion: "Unverified Other Remix" } }, { identityKey: "tidal:999", title: "foreign" });
  const before = structuredClone(wrapped), result = f.service.observeCandidates(wrapped, anchorOptions(f));
  assert.equal(result.candidates, wrapped); assert.deepEqual(wrapped, before); assert.equal(result.diagnostics.scoutsReturned, 2); assert.equal(result.diagnostics.preparedCandidateCount, 2);
  assert.equal(result.diagnostics.cache[MODELS[0]].warm, 3); privateFree(result.diagnostics, f);
  for (const patch of [{ title: "Wrong title" }, { artist: "Wrong artist" }, { durationMs: 1 }, { isrc: "different" }, { id: 999 }, { mixVersion: undefined }, { durationMs: undefined }]) {
    const mismatch = f.service.observeCandidates([{ ...f.entries[1].track, ...patch }], anchorOptions(f));
    assert.equal(mismatch.diagnostics.scoutsReturned, 0); assert.equal(mismatch.diagnostics.neutral, true);
  }
});
test("an explicitly frozen zero-candidate request remains warm but returns a neutral empty-pool observation", t => {
  const f = fixture(t, { warm: MODELS, candidateCount: 0 }); f.configure();
  const before = tree(f.privateRoot), status = f.service.status(), actual = [{ identityKey: "tidal:999", title: "untouched live pick" }];
  assert.equal(status.preparedRequestCount, 1); assert.equal(status.preparedPoolCount, 1); assert.equal(status.cacheReady, true);
  assert.equal(status.jointWarmSourceCount, 1); assert.ok(MODELS.every(model => status.models[model].warm === 1));
  const result = f.service.observeCandidates(actual, anchorOptions(f));
  assert.equal(result.candidates, actual); assert.equal(result.diagnostics.reason, "no-eligible-catalog-candidates");
  assert.equal(result.diagnostics.scoutsReturned, 0); assert.equal(result.diagnostics.preparedCandidateCount, 0);
  assert.equal(result.diagnostics.neutral, true); assert.equal(result.diagnostics.fallback, true); assert.equal(result.diagnostics.partialCoverage, false);
  assert.equal(result.diagnostics.singleModelFallback, false); assert.equal(result.diagnostics.missingModelIsNegative, false);
  assert.deepEqual(tree(f.privateRoot), before); privateFree(status, f); privateFree(result.diagnostics, f);
});
test("exact prepared anchor names, explicit mix and all supplied provider IDs must match", t => {
  const f = fixture(t, { warm: MODELS }); f.configure();
  for (const patch of [{ identityKey: "tidal:999" }, { title: "Recording 100 (Another Remix)" }, { artist: "Different artist" },
    { mixVersion: "Original Mix" }, { mixName: "Another Remix" }, { tidalId: "999" }, { id: 999 }, { tidalTrackId: "999" }, { tidal: { id: "999" } }, { isrc: "different" }]) {
    const result = f.service.observeCandidates([], { options: { anchorTrack: { ...f.entries[0].track, ...patch } } });
    assert.equal(result.diagnostics.reason, "anchor-not-exact-prepared-request"); assert.equal(result.diagnostics.neutral, true); assert.equal(result.diagnostics.scoutsReturned, 0);
  }
  assert.equal(f.service.observeCandidates(liveCandidates(f), { options: { anchorTrack: { ...f.entries[0].track, id: 100 } } }).diagnostics.scoutsReturned, 6);
});
test("corrupt cache audio or model receipts remain unavailable without any repairs", t => {
  const f = fixture(t, { warm: MODELS }); f.configure();
  const entry = f.entries[0], file = path.join(f.directory, "cache", "results", `${entry.source.sourceSha256}-${analysisSpec(MODELS[1]).key}.json`), receipt = JSON.parse(fs.readFileSync(file));
  receipt.revision = "unapproved-model-revision"; write(file, receipt); const before = tree(f.privateRoot), result = f.service.observeCandidates(liveCandidates(f), anchorOptions(f));
  assert.equal(result.diagnostics.cache[MODELS[1]].unavailable, 1); assert.equal(result.diagnostics.singleModelFallback, true); assert.equal(result.diagnostics.fallback, true);
  fs.writeFileSync(path.join(f.directory, "cache", "sources", `${entry.source.sourceSha256}.audio`), "changed source bytes");
  assert.equal(f.service.observeCandidates(liveCandidates(f), anchorOptions(f)).diagnostics.scoutsReturned, 0); assert.equal(f.service.status().cacheReady, false);
  assert.deepEqual(tree(f.privateRoot), before);
});
test("missing or changed frozen pool, recipe, model or code pins fail closed", t => {
  for (const change of [f => { fs.appendFileSync(path.join(f.directory, "pool.json"), " "); }, f => { f.request.recipe.agreementWeight = .05; f.reseal(); },
    f => { f.plan.models[0].revision = "another"; write(path.join(f.directory, "plan.json"), f.plan); },
    f => { f.plan.code.files[0].sha256 = "0".repeat(64); write(path.join(f.directory, "plan.json"), f.plan); },
    f => { f.plan.code.files.pop(); write(path.join(f.directory, "plan.json"), f.plan); }, f => { fs.unlinkSync(f.entries[0].sourceFile); }]) {
    const f = fixture(t); f.configure(); change(f); const before = tree(f.privateRoot), result = f.service.observeCandidates([], anchorOptions(f));
    assert.equal(result.diagnostics.reason, "missing-or-stale-prepared-pilot"); assert.equal(result.diagnostics.neutral, true); assert.equal(f.service.status().preparedPoolCount, 0);
    assert.deepEqual(tree(f.privateRoot), before); assert.throws(() => f.service.configure({ selector: "mert-fullsong" }));
  }
});
test("changed exact source/name/candidate identities are rejected even with refreshed JSON digests", t => {
  for (const change of [f => { f.pool.entries[1].track.mixVersion = "Another Mix"; }, f => { f.pool.entries[1].source.spans[0][0]++; },
    f => { f.pool.requests[0].candidateIdentityKeys.push("tidal:999"); }, f => { f.pool.requests[0].candidateIdentityKeys.push(f.entries[0].track.identityKey); },
    f => { f.pool.entries[1].source.sourceSha256 = "1".repeat(64); }]) {
    const f = fixture(t); change(f); f.reseal(); assert.throws(() => f.configure()); assert.equal(fs.existsSync(f.service.configFile), false);
  }
});
test("invalid modes, selectors, options or malformed saved configuration never enable production", t => {
  const f = fixture(t);
  for (const config of [{ mode: "production" }, { selector: "effnet-control" }, { scoutCount: 7 }, { agreementWeight: .05 }, { productionApplied: true }]) assert.throws(() => f.service.configure(config));
  assert.equal(fs.existsSync(f.service.configFile), false); fs.writeFileSync(f.service.configFile, "{not-json");
  const loaded = new SonicCatalogScoutService({ privateRoot: f.privateRoot, projectRoot: ROOT }), result = loaded.observeCandidates([], anchorOptions(f));
  assert.equal(result.diagnostics.mode, "off"); assert.equal(loaded.status().configurationError, "invalid-private-configuration");
  assert.throws(() => new SonicCatalogScoutService({ privateRoot: f.privateRoot, projectRoot: ROOT, configFile: "../escape.json" }));
});
test("private paths cannot escape through pilot/source junctions or a later directory substitution", t => {
  const f = fixture(t), outside = path.join(f.temporary, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "sentinel"), "preserve");
  assert.throws(() => f.service.configure({ mode: "observe", pilotDirectory: outside }));
  const link = path.join(f.privateRoot, "linked"); fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.service.configure({ mode: "observe", pilotDirectory: link }));
  f.configure(); fs.renameSync(f.directory, path.join(f.privateRoot, "preserved-pilot")); fs.symlinkSync(outside, f.directory, process.platform === "win32" ? "junction" : "dir");
  const observed = f.service.observeCandidates([], anchorOptions(f)); assert.equal(observed.diagnostics.neutral, true); assert.equal(observed.diagnostics.reason, "missing-or-stale-prepared-pilot");
  assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "preserve"); assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);
});
test("a source outside the sealed pilot directory is rejected and no files are written there", t => {
  const f = fixture(t), external = path.join(f.privateRoot, "elsewhere.audio"); fs.writeFileSync(external, f.entries[0].audioBytes);
  f.pool.entries[0].sourceFile = external; f.reseal(); const before = hash(fs.readFileSync(external));
  assert.throws(() => f.configure()); assert.equal(hash(fs.readFileSync(external)), before); assert.equal(fs.existsSync(f.service.configFile), false);
});
