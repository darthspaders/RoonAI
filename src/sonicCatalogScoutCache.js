"use strict";

// Private, bounded evidence storage. Reads never create files, fetch providers,
// construct workers, open databases or schedule analysis.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { analysisSpec } = require("./sonicAnalysisSpec");
const { assertSonicSourceSnapshot } = require("./sonicCandidateCorpus");
const { readPrivateResultReceipt, validateStoredResult } = require("./sonicAnchorExperiment");

const MODELS = Object.freeze(["mert-fullsong", "mert-30s"]);
const MAX_SOURCES = 100, MAX_SOURCE_BYTES = 20 * 1024 * 1024, MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_PRIVATE_ROOT = path.resolve(__dirname, "../data");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (_, item) => plain(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const clone = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function keys(value, allowed) { assert.ok(plain(value) && Object.keys(value).every(key => allowed.includes(key)), "Invalid scout cache arguments."); }
function inside(root, target) { const relative = path.relative(root, target); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function unavailable(reason, analyzer, source, spec) {
  return freeze({ status: "unavailable", reason, analyzer: analyzer || null, specKey: spec?.key || null, sourceSha256: source?.sourceSha256 || null,
    neutral: true, missingModelIsNegative: false, receipt: null, record: null });
}

class SonicCatalogScoutCache {
  constructor(options = {}) {
    keys(options, ["directory", "privateRoot", "maxSources"]);
    const privateRoot = options.privateRoot || DEFAULT_PRIVATE_ROOT;
    assert.ok(typeof privateRoot === "string" && path.isAbsolute(privateRoot), "Choose an explicit absolute private root.");
    assert.ok(fs.existsSync(privateRoot) && fs.lstatSync(privateRoot).isDirectory() && !fs.lstatSync(privateRoot).isSymbolicLink(), "The private root must be an existing real directory.");
    this.privateRoot = fs.realpathSync(privateRoot);
    assert.ok(typeof options.directory === "string" && options.directory, "Choose a private scout cache directory.");
    this.directory = path.resolve(this.privateRoot, options.directory);
    assert.ok(this.directory !== this.privateRoot && inside(this.privateRoot, this.directory), "The scout cache must be a child of its private root.");
    this.maxSources = options.maxSources ?? MAX_SOURCES;
    assert.ok(Number.isInteger(this.maxSources) && this.maxSources >= 1 && this.maxSources <= MAX_SOURCES, "A scout cache is bounded to at most 100 exact sources.");
    this.assertPath(this.directory);
    Object.freeze(this);
  }

  assertPath(target, regularFile = false) {
    assert.ok(inside(this.privateRoot, target) && target !== this.privateRoot, "Cache path escaped its private root.");
    assert.ok(fs.lstatSync(this.privateRoot).isDirectory() && !fs.lstatSync(this.privateRoot).isSymbolicLink() && fs.realpathSync(this.privateRoot) === this.privateRoot, "The private root changed.");
    const parts = path.relative(this.privateRoot, target).split(path.sep); let current = this.privateRoot;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      if (!fs.existsSync(current)) {
        // existsSync follows broken links. lstat catches them without following.
        try { fs.lstatSync(current); assert.fail("Cache path contains an unresolved link."); } catch (error) { if (error.code !== "ENOENT") throw error; }
        break;
      }
      const stat = fs.lstatSync(current);
      assert.ok(!stat.isSymbolicLink() && inside(this.privateRoot, fs.realpathSync(current)), "Cache path contains a link or escaped its private root.");
      const final = index === parts.length - 1;
      assert.ok(final && regularFile ? stat.isFile() : stat.isDirectory(), "Cache artifacts must be regular files beneath real directories.");
    }
    return target;
  }

  file(relative) { return this.assertPath(path.resolve(this.directory, relative), true); }
  ensureDirectory(directory) {
    this.assertPath(directory);
    let current = this.privateRoot;
    for (const part of path.relative(this.privateRoot, directory).split(path.sep)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) { try { fs.mkdirSync(current); } catch (error) { if (error.code !== "EEXIST") throw error; } }
      this.assertPath(current);
    }
  }
  readBytes(file, maximum) {
    this.assertPath(file, true); const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= maximum, "Cache artifact exceeds its byte bound.");
    const bytes = fs.readFileSync(file); assert.equal(bytes.length, stat.size, "Cache artifact changed during its read."); return bytes;
  }
  readJson(file) { return JSON.parse(this.readBytes(file, MAX_JSON_BYTES).toString("utf8")); }
  sourcePaths(source) { return { audio: this.file(`sources/${source.sourceSha256}.audio`), snapshot: this.file(`sources/${source.sourceSha256}.json`) }; }
  resultPath(source, spec) { return this.file(`results/${source.sourceSha256}-${spec.key}.json`); }

  validate(input, ingest = false) {
    keys(input, ingest ? ["track", "source", "analyzer", "receipt", "audioBytes"] : ["track", "source", "analyzer"]);
    assert.ok(MODELS.includes(input.analyzer), "Only the two current pinned MERT models belong in this cache.");
    const spec = analysisSpec(input.analyzer);
    assertSonicSourceSnapshot(input.source, { track: input.track, ...(ingest ? { audioBytes: input.audioBytes } : {}) });
    assert.equal(input.source.sourceType, "beatport-preview", "Scout cache sources must be exact catalog previews.");
    assert.ok(input.source.byteLength <= MAX_SOURCE_BYTES, "Scout preview exceeds its byte bound.");
    if (ingest) {
      assert.ok(input.audioBytes instanceof Uint8Array, "Ingestion requires the exact original preview bytes.");
      readPrivateResultReceipt(input.receipt, spec, input.source);
      assert.ok(Buffer.byteLength(JSON.stringify(input.receipt)) <= MAX_JSON_BYTES, "Typed receipt exceeds its byte bound.");
    }
    return spec;
  }

  get(input = {}) {
    let spec;
    try { spec = this.validate(input); } catch { return unavailable("invalid-source-or-model", input?.analyzer, input?.source, spec); }
    try {
      const source = this.sourcePaths(input.source), result = this.resultPath(input.source, spec);
      const present = [source.audio, source.snapshot, result].map(file => fs.existsSync(file));
      if (!present.some(Boolean)) return freeze({ status: "cold", reason: "source-not-cached", analyzer: input.analyzer, specKey: spec.key, sourceSha256: input.source.sourceSha256,
        neutral: true, missingModelIsNegative: false, receipt: null, record: null });
      if (!present[0] || !present[1]) return unavailable("incomplete-source-cache", input.analyzer, input.source, spec);
      assert.equal(canonical(this.readJson(source.snapshot)), canonical(input.source), "Cached source snapshot belongs to another exact recording.");
      assertSonicSourceSnapshot(input.source, { track: input.track, audioBytes: this.readBytes(source.audio, MAX_SOURCE_BYTES) });
      if (!present[2]) return freeze({ status: "cold", reason: "model-not-cached", analyzer: input.analyzer, specKey: spec.key, sourceSha256: input.source.sourceSha256,
        neutral: true, missingModelIsNegative: false, receipt: null, record: null });
      const receipt = this.readJson(result), raw = readPrivateResultReceipt(receipt, spec, input.source), validated = validateStoredResult(raw, spec, input.source);
      return freeze({ status: "warm", reason: null, analyzer: input.analyzer, specKey: spec.key, sourceSha256: input.source.sourceSha256, neutral: false, missingModelIsNegative: false,
        receipt, record: { identityKey: input.track.identityKey, analyzer: input.analyzer, repo: spec.repo, specKey: spec.key, revision: spec.revision,
          sampleRate: spec.sampleRate, dimensions: spec.dimensions, sourceSnapshotKey: input.source.snapshotKey, sourceSha256: input.source.sourceSha256,
          spans: validated.evidence.spans, vector: validated.vector } });
    } catch { return unavailable("invalid-or-unreadable-cache", input.analyzer, input.source, spec); }
  }

  status(input = {}) {
    keys(input, ["track", "source"]);
    const models = MODELS.map(analyzer => this.get({ ...input, analyzer })).map(({ status, reason, analyzer, specKey, neutral }) => ({ status, reason, analyzer, specKey, neutral }));
    const jointReady = models.every(model => model.status === "warm");
    return freeze({ status: jointReady ? "warm" : models.some(model => model.status === "unavailable") ? "unavailable" : "cold", jointReady,
      models, missingModels: models.filter(model => model.status !== "warm").map(model => model.analyzer), missingModelIsNegative: false, inferenceStarted: false });
  }

  sameArtifact(file, bytes, maximum) {
    const existing = this.readBytes(file, maximum);
    return file.endsWith(".json") ? canonical(JSON.parse(existing.toString("utf8"))) === canonical(JSON.parse(Buffer.from(bytes).toString("utf8"))) : existing.equals(Buffer.from(bytes));
  }
  writeExclusive(file, bytes) {
    this.assertPath(file, true);
    if (fs.existsSync(file)) { assert.ok(this.sameArtifact(file, bytes, file.endsWith(".json") ? MAX_JSON_BYTES : MAX_SOURCE_BYTES), "Conflicting cache artifact; existing evidence is never overwritten."); return false; }
    const temporary = this.file(`${path.relative(this.directory, file)}.${randomUUID()}.tmp`); let created = false;
    try {
      fs.writeFileSync(temporary, bytes, { flag: "wx" }); created = true; this.assertPath(file, true); this.assertPath(temporary, true);
      try { fs.linkSync(temporary, file); return true; }
      catch (error) { if (error.code !== "EEXIST") throw error; assert.ok(this.sameArtifact(file, bytes, file.endsWith(".json") ? MAX_JSON_BYTES : MAX_SOURCE_BYTES), "Concurrent conflicting cache evidence."); return false; }
    } finally { if (created) { this.assertPath(temporary, true); fs.unlinkSync(temporary); } }
  }

  ingest(input = {}) {
    const spec = this.validate(input, true);
    this.sourcePaths(input.source); this.resultPath(input.source, spec);
    this.assertPath(path.join(this.directory, "sources")); this.assertPath(path.join(this.directory, "results"));
    this.ensureDirectory(this.directory);
    const lock = this.file(".ingest.lock"), token = randomUUID();
    // One synchronous ingest at a time across CLI/server processes. Existing
    // locks are preserved; a reader never removes or repairs another writer.
    fs.writeFileSync(lock, JSON.stringify({ token, pid: process.pid }) + "\n", { flag: "wx" });
    try { return this.#ingestValidated(input, spec); }
    finally { assert.equal(this.readJson(lock).token, token, "Cache ingest ownership changed."); this.assertPath(lock, true); fs.unlinkSync(lock); }
  }

  #ingestValidated(input, spec) {
    const source = this.sourcePaths(input.source), result = this.resultPath(input.source, spec);
    const sources = fs.existsSync(path.join(this.directory, "sources")) ? fs.readdirSync(path.join(this.directory, "sources")) : [];
    assert.ok(sources.every(file => /^[a-f0-9]{64}\.(?:json|audio)$/.test(file)), "Unexpected private source-cache entries.");
    const hashes = new Set(sources.map(file => file.slice(0, 64)));
    assert.ok(hashes.has(input.source.sourceSha256) || hashes.size < this.maxSources, "The bounded scout cache has reached its source limit.");
    const snapshotBytes = Buffer.from(JSON.stringify(clone(input.source)) + "\n"), resultBytes = Buffer.from(JSON.stringify(clone(input.receipt)) + "\n");
    // Check every existing artifact before publishing any new evidence.
    for (const [file, bytes, bound] of [[source.audio, input.audioBytes, MAX_SOURCE_BYTES], [source.snapshot, snapshotBytes, MAX_JSON_BYTES], [result, resultBytes, MAX_JSON_BYTES]]) {
      if (fs.existsSync(file)) assert.ok(this.sameArtifact(file, bytes, bound), "Conflicting cache artifact; existing evidence is never overwritten.");
    }
    this.ensureDirectory(path.join(this.directory, "sources")); this.ensureDirectory(path.join(this.directory, "results"));
    const audioWritten = this.writeExclusive(source.audio, input.audioBytes), snapshotWritten = this.writeExclusive(source.snapshot, snapshotBytes), receiptWritten = this.writeExclusive(result, resultBytes);
    const output = this.get({ track: input.track, source: input.source, analyzer: input.analyzer }); assert.equal(output.status, "warm", "Ingested cache evidence failed revalidation.");
    return freeze({ status: "warm", created: audioWritten || snapshotWritten || receiptWritten, sourceCreated: audioWritten, receiptCreated: receiptWritten,
      analyzer: input.analyzer, specKey: spec.key, sourceSha256: input.source.sourceSha256, inferenceStarted: false, runtimeDatabaseWrites: 0 });
  }
}

module.exports = { SonicCatalogScoutCache, MODELS, MAX_SOURCES, MAX_SOURCE_BYTES, MAX_JSON_BYTES };
