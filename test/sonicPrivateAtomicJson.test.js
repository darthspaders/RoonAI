"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { updatePrivateJson, PrivateAtomicJsonError, PRIVATE_JSON_POLICY } = require("../src/sonicPrivateAtomicJson");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sonic-private-json-")), file = path.join(directory, "collection.json");
  t.after(() => {
    const actual = fs.realpathSync(directory), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith("sonic-private-json-")); fs.rmSync(actual, { recursive: true });
  });
  return { directory, file };
}
const failed = code => Object.assign(Error("PRIVATE raw path and token must not escape"), { code });
test("transient Windows replacement locks retry the same complete checkpoint without serializing again", t => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const f = fixture(t); fs.writeFileSync(f.file, '{"prior":true}\n'); let serializations = 0, writes = 0, renames = 0;
    const bytes = [], paths = [], value = { toJSON() { serializations++; return { attempts: 21, sources: 5, completeCheckpoint: true }; } };
    const result = updatePrivateJson(f.file, value, { fsImpl: { ...fs,
      writeFileSync(file, data, options) { writes++; assert.equal(options.flag, "wx"); assert.equal(options.mode, 0o600); fs.writeFileSync(file, data, options); },
      renameSync(from, to) {
        renames++; paths.push(from); bytes.push(fs.readFileSync(from, "utf8"));
        assert.equal(fs.readFileSync(to, "utf8"), '{"prior":true}\n');
        if (renames <= 2) throw failed(code); fs.renameSync(from, to);
      } } });
    assert.deepEqual(result, { ok: true, renameAttempts: 3, checkpointRetained: false });
    assert.equal(serializations, 1); assert.equal(writes, 1); assert.equal(renames, 3); assert.equal(new Set(paths).size, 1); assert.equal(new Set(bytes).size, 1);
    assert.equal(fs.readFileSync(f.file, "utf8"), bytes[0]); assert.deepEqual(fs.readdirSync(f.directory), ["collection.json"]);
  }
});
test("permanent lock retains the full recoverable checkpoint and leaves the prior destination unchanged", t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{"prior":true}\n'); let renames = 0, temporary;
  const value = { attempts: Array.from({ length: 21 }, (_, i) => ({ id: i, status: "attempted" })), sources: [1, 2, 3, 4, 5] };
  const expected = JSON.stringify(value, null, 2) + "\n";
  assert.throws(() => updatePrivateJson(f.file, value, { fsImpl: { ...fs, renameSync(from) { renames++; temporary = from; assert.equal(fs.readFileSync(from, "utf8"), expected); throw failed("EPERM"); } } }),
    error => error instanceof PrivateAtomicJsonError && error.code === "PRIVATE_JSON_REPLACE_FAILED" && error.filesystemCode === "EPERM"
      && error.renameAttempts === 5 && error.checkpointRetained === true && !/PRIVATE raw|token|collection\.json|sonic-private-json/.test(JSON.stringify(error) + error.message));
  assert.equal(renames, 5); assert.equal(fs.readFileSync(temporary, "utf8"), expected); assert.equal(fs.readFileSync(f.file, "utf8"), '{"prior":true}\n');
  assert.equal(fs.readdirSync(f.directory).length, 2); assert.ok(PRIVATE_JSON_POLICY.maximumBackoffMs <= 1000);
});
test("unrelated replacement failures receive no retry and retain complete bytes", t => {
  for (const code of ["EXDEV", "ENOSPC", "EIO", "UNKNOWN_PRIVATE_MESSAGE"]) {
    const f = fixture(t); let renames = 0, temporary;
    assert.throws(() => updatePrivateJson(f.file, { closed: true }, { fsImpl: { ...fs, renameSync(from) { renames++; temporary = from; throw failed(code); } } }),
      error => error.renameAttempts === 1 && error.checkpointRetained === true && error.filesystemCode === (code === "UNKNOWN_PRIVATE_MESSAGE" ? "UNKNOWN" : code));
    assert.equal(renames, 1); assert.deepEqual(JSON.parse(fs.readFileSync(temporary, "utf8")), { closed: true }); assert.equal(fs.existsSync(f.file), false);
  }
});
test("exclusive initial temporary creation cannot overwrite another checkpoint", t => {
  const f = fixture(t); let renames = 0, temporary;
  assert.throws(() => updatePrivateJson(f.file, { new: true }, { fsImpl: { ...fs,
    writeFileSync(file, data, options) { temporary = file; fs.writeFileSync(file, '{"otherOwner":true}\n', { flag: "wx" }); fs.writeFileSync(file, data, options); },
    renameSync() { renames++; } } }), error => error.code === "PRIVATE_JSON_WRITE_FAILED" && error.filesystemCode === "EEXIST" && error.checkpointRetained === false);
  assert.equal(renames, 0); assert.equal(fs.readFileSync(temporary, "utf8"), '{"otherOwner":true}\n'); assert.equal(fs.existsSync(f.file), false);
});
test("serialization and initial write failure never trigger replacement retries", t => {
  const f = fixture(t), circular = {}; circular.circular = circular; let writes = 0, renames = 0;
  const fsImpl = { ...fs, writeFileSync() { writes++; throw failed("ENOSPC"); }, renameSync() { renames++; } };
  assert.throws(() => updatePrivateJson(f.file, circular, { fsImpl }), error => error.code === "PRIVATE_JSON_SERIALIZATION_FAILED");
  assert.equal(writes, 0); assert.throws(() => updatePrivateJson(f.file, { valid: true }, { fsImpl }), error => error.code === "PRIVATE_JSON_WRITE_FAILED" && error.checkpointRetained === false);
  assert.equal(writes, 1); assert.equal(renames, 0); assert.deepEqual(fs.readdirSync(f.directory), []);
});
test("symlink destinations and parent directories are rejected without replacing their targets", t => {
  const f = fixture(t), destination = path.join(f.directory, "actual.json"), link = path.join(f.directory, "linked.json");
  fs.writeFileSync(destination, '{"unchanged":true}\n');
  // Inject the lstat classification rather than requiring Windows symlink
  // privilege; all other file operations remain real and destination untouched.
  const fsImpl = { ...fs, lstatSync(file) { if (file === link) return { isSymbolicLink: () => true, isFile: () => true }; return fs.lstatSync(file); } };
  assert.throws(() => updatePrivateJson(link, { changed: true }, { fsImpl }), error => error.code === "PRIVATE_JSON_PATH_FAILED");
  const parentFs = { ...fs, lstatSync(file) { if (file === f.directory) return { isDirectory: () => true, isSymbolicLink: () => true }; return fs.lstatSync(file); } };
  assert.throws(() => updatePrivateJson(f.file, { changed: true }, { fsImpl: parentFs }), error => error.code === "PRIVATE_JSON_PATH_FAILED");
  assert.equal(fs.readFileSync(destination, "utf8"), '{"unchanged":true}\n'); assert.deepEqual(fs.readdirSync(f.directory), ["actual.json"]);
});
test("a symlink introduced before replacement fails closed with the completed owned checkpoint retained", t => {
  const f = fixture(t); let targetChecks = 0, renames = 0;
  const fsImpl = { ...fs, lstatSync(file) {
    if (file === f.file && ++targetChecks > 1) return { isSymbolicLink: () => true, isFile: () => true };
    return fs.lstatSync(file);
  }, renameSync() { renames++; } };
  assert.throws(() => updatePrivateJson(f.file, { full: "checkpoint" }, { fsImpl }), error => error.code === "PRIVATE_JSON_PATH_FAILED" && error.checkpointRetained === true);
  assert.equal(renames, 0); const files = fs.readdirSync(f.directory); assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, files[0]), "utf8")), { full: "checkpoint" });
});
