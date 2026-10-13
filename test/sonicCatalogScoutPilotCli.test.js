"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { main } = require("../scripts/sonic-catalog-scout-pilot");
const { freezeSonicSourceSnapshot } = require("../src/sonicCandidateCorpus");

const ROOT = path.resolve(__dirname, ".."), DATA = fs.realpathSync(path.join(ROOT, "data"));
const clone = value => structuredClone(value), sha = bytes => createHash("sha256").update(bytes).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
function tree(directory) {
  const files = {};
  const visit = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file); else files[path.relative(directory, file)] = sha(fs.readFileSync(file));
    }
  };
  visit(directory); return files;
}
function fixture(t) {
  const prefix = `sonic-catalog-scout-cli-test-${randomUUID()}`, owned = new Set();
  const location = suffix => { const directory = path.join(DATA, `${prefix}-${suffix}`); owned.add(directory); return directory; };
  const base = location("base"), output = location("extended"); fs.mkdirSync(base); fs.mkdirSync(path.join(base, "audio"));
  t.mock.method(console, "log", () => {});
  t.after(() => {
    for (const directory of owned) {
      const resolved = path.resolve(directory), relative = path.relative(DATA, resolved);
      assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(resolved).startsWith(prefix + "-"));
      if (fs.existsSync(resolved)) {
        assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false); assert.equal(fs.realpathSync(resolved), resolved);
        fs.rmSync(resolved, { recursive: true });
      }
    }
  });
  const request = { version: 1, createdAt: "2026-10-08T01:02:03.000Z",
    recipe: { kind: "catalog-scout-end-to-end", finalCount: 3, scoutCount: 6, agreementWeight: 0,
      maxSources: 100, maxAnchorAttempts: 4, maxCandidateAttempts: 18, maxCandidatesPerRequest: 12,
      maxQueriesPerRequest: 3, maxResultsPerQuery: 18, maxTidalQueriesPerSource: 3, maxTidalResultsPerQuery: 12, productionApplied: false },
    requests: [{ requestId: "synthetic-family", anchorQuery: "Fixture Artist", queries: ["Fixture Artist", "Fixture Peer", "Fixture Other"], lane: "Synthetic lane" }],
    excluded: [{ identityKey: "tidal:9000", artist: "Previous fixture", title: "Named version", mixVersion: "Test Remix" }],
    excludedSourceSha256: ["a".repeat(64)], tasteSnapshot: { artists: { fixture: { score: 2 } }, feedback: {}, calibration: { lanes: [] } },
    historySnapshot: { entries: [{ key: "tidal:9000", keys: ["tidal:9000"], lastShownAt: 1791427200000, shownCount: 2 }], settings: { recentWindowMs: 259200000 } },
    labelsUsedForSelection: false, heldOutValidation: false, productionApplied: false };
  const entries = [1, 2].map(id => {
    const track = { identityKey: `tidal:${id}`, tidalId: String(id), artist: "Fixture Artist", title: `Fixture Track ${id}`, mixVersion: "Original Mix", durationMs: 360000, isrc: `USAAA260000${id}` };
    const bytes = Buffer.from(`private synthetic exact audio bytes ${id}`), sourceFile = path.join(base, "audio", sha(bytes) + ".audio");
    fs.writeFileSync(sourceFile, bytes);
    const source = freezeSonicSourceSnapshot({ track, sourceType: "beatport-preview", audioBytes: bytes, durationSeconds: 120,
      sourceTrack: { id: String(100 + id), artist: track.artist, title: track.title, mixName: "Original Mix", durationMs: 360000, isrc: track.isrc }, allowVersionProxy: false });
    return { track, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: clone(track) }, source, sourceFile,
      metadata: { query: "Fixture Artist", discoverySource: "frozen synthetic provider page", discoveryLane: "core", bpm: 128 } };
  });
  write(path.join(base, "request.json"), request);
  const progress = { version: 1, candidateProviderPolicy: "beatport-artist-pages-tidal-exact", requestSha256: sha(fs.readFileSync(path.join(base, "request.json"))),
    pages: [{ query: "Fixture Artist", provider: "beatport", page: 1, status: "ready", at: "2026-10-08T01:03:00.000Z",
      tracks: [{ id: "101", artist: "Fixture Artist", title: "Fixture Track 1", mixName: "Original Mix" }] }], entries,
    requests: [{ requestId: "synthetic-family", anchorIdentityKey: "tidal:1", candidateIdentityKeys: ["tidal:2"], complete: false,
      options: { count: 3, genres: "Synthetic lane", anchorTrack: clone(entries[0].track) } }],
    attempts: [{ requestId: "synthetic-family", beatportTrackId: "101", role: "anchor", status: "frozen-exact", identityKey: "tidal:1",
      tidalQueries: [{ query: "Fixture Artist Fixture Track 1", status: "complete", pageCount: 1 }], canonicalLookups: [{ tidalId: "1", status: "verified" }] },
    { requestId: "synthetic-family", beatportTrackId: "199", role: "candidate", status: "unavailable-or-unverified", reason: "Exact preview unavailable." },
    { requestId: "synthetic-family", beatportTrackId: "198", role: "candidate", status: "started", tidalQueries: [{ query: "Interrupted fixture query", status: "started" }] }] };
  write(path.join(base, "collection.json"), progress);
  const relative = directory => path.relative(ROOT, directory);
  const run = () => main(["extend", "--output", relative(output), "--from", relative(base)]);
  return { base, output, request, progress, entries, location, relative, run };
}

test("extend copies exact source snapshots and frozen collection evidence while preserving original bytes", async t => {
  const f = fixture(t), original = tree(f.base), oldRequestBytes = fs.readFileSync(path.join(f.base, "request.json")), oldProgressBytes = fs.readFileSync(path.join(f.base, "collection.json"));
  await f.run(); assert.deepEqual(tree(f.base), original);
  const request = read(path.join(f.output, "request.json")), progress = read(path.join(f.output, "collection.json"));
  const expected = clone(f.request); expected.recipe.maxAnchorAttempts = 18; expected.recipe.maxCandidateAttempts = 36;
  expected.collectionExtension = { reason: "exact catalog source coverage before any model ranking or listening", baseDirectory: f.relative(f.base),
    requestSha256: sha(oldRequestBytes), collectionSha256: sha(oldProgressBytes), priorProviderAttempts: 3, priorModelRuns: 0 };
  assert.deepEqual(request, expected); assert.deepEqual(progress.pages, f.progress.pages); assert.deepEqual(progress.attempts, f.progress.attempts);
  assert.deepEqual(progress.requests, f.progress.requests); assert.deepEqual(request.tasteSnapshot, f.request.tasteSnapshot); assert.deepEqual(request.historySnapshot, f.request.historySnapshot);
  assert.equal(progress.requestSha256, sha(fs.readFileSync(path.join(f.output, "request.json")))); assert.notEqual(progress.requestSha256, f.progress.requestSha256);
  const expectedProgress = clone(f.progress); expectedProgress.requestSha256 = progress.requestSha256;
  for (const [index, entry] of progress.entries.entries()) {
    const old = f.entries[index], expectedPath = path.join(f.output, "audio", old.source.sourceSha256 + ".audio");
    assert.equal(entry.sourceFile, expectedPath); assert.notEqual(entry.sourceFile, old.sourceFile);
    assert.deepEqual(fs.readFileSync(entry.sourceFile), fs.readFileSync(old.sourceFile)); assert.deepEqual(entry.source, old.source);
    assert.deepEqual(entry.verification, old.verification); expectedProgress.entries[index].sourceFile = expectedPath;
  }
  assert.deepEqual(progress, expectedProgress);
  const receipt = read(path.join(f.output, "collection-code-receipt.json")); assert.ok(receipt.files.length > 0);
  for (const file of receipt.files) assert.equal(file.sha256, sha(fs.readFileSync(path.join(ROOT, file.path))));
  assert.deepEqual(fs.readdirSync(f.output).sort(), ["audio", "collection-code-receipt.json", "collection.json", "guards", "request.json"]);
});

test("sealed or previously inferred collection cannot be extended or overwritten", async t => {
  for (const marker of ["plan.json", "inference-attempts.json"]) {
    const f = fixture(t); write(path.join(f.base, marker), marker === "plan.json" ? { sealed: true } : []); const before = tree(f.base);
    await assert.rejects(f.run, /Only uninferred/); assert.equal(fs.existsSync(f.output), false); assert.deepEqual(tree(f.base), before);
  }
  const f = fixture(t); fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output, "sentinel"), "existing private output");
  const before = tree(f.output); await assert.rejects(f.run); assert.deepEqual(tree(f.output), before);
});

test("an exact-byte source outside the private base is rejected without copying it", async t => {
  const f = fixture(t), outside = f.location("outside"); fs.mkdirSync(outside);
  const source = path.join(outside, "same-source.audio"); fs.copyFileSync(f.entries[0].sourceFile, source);
  f.progress.entries[0].sourceFile = source; write(path.join(f.base, "collection.json"), f.progress);
  const before = tree(f.base), outsideBefore = tree(outside); await assert.rejects(f.run);
  assert.deepEqual(tree(f.base), before); assert.deepEqual(tree(outside), outsideBefore);
  assert.deepEqual(fs.readdirSync(path.join(f.output, "audio")), []); assert.equal(fs.existsSync(path.join(f.output, "request.json")), false);
});

test("changed original source bytes cannot create a new frozen input or rewrite prior evidence", async t => {
  const f = fixture(t); fs.appendFileSync(f.entries[0].sourceFile, "altered"); const before = tree(f.base);
  await assert.rejects(f.run, /Original audio bytes changed/); assert.deepEqual(tree(f.base), before);
  assert.deepEqual(fs.readdirSync(path.join(f.output, "audio")), []); assert.equal(fs.existsSync(path.join(f.output, "collection.json")), false);
});

test("collection hash mismatch fails before creating an extended directory", async t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.base, "request.json"), " "); const before = tree(f.base);
  await assert.rejects(f.run); assert.equal(fs.existsSync(f.output), false); assert.deepEqual(tree(f.base), before);
});

test("main rejects malformed extension arguments and private-root escapes without running other stages", async t => {
  const f = fixture(t), valid = ["extend", "--output", f.relative(f.output), "--from", f.relative(f.base)], before = tree(f.base);
  const variants = [[], valid.slice(0, 3), [...valid, "extra"], ["extend", "--from", f.relative(f.output), "--output", f.relative(f.base)],
    ["unknown", "--output", f.relative(f.output)], ["extend", "--output", path.join(ROOT, "data", "sonic-catalog-scout-absolute"), "--from", f.relative(f.base)],
    ["extend", "--output", "../sonic-catalog-scout-outside", "--from", f.relative(f.base)], ["extend", "--output", "data/sonic-catalog-scout-test/../escape", "--from", f.relative(f.base)],
    ["extend", "--output", "data/unrelated-output", "--from", f.relative(f.base)], ["extend", "--output", f.relative(f.output), "--from", "data/other-base"],
    ["extend", "--output", f.relative(f.base), "--from", f.relative(f.base)]];
  for (const args of variants) await assert.rejects(() => main(args));
  assert.equal(fs.existsSync(f.output), false); assert.deepEqual(tree(f.base), before);
});
