"use strict";

// Private checkpoint replacement only. A rename lock never repeats acquisition,
// analysis or other caller work. The caller owns and scopes the destination.
const fs = require("node:fs"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const RETRY_DELAYS_MS = Object.freeze([20, 40, 80, 120]);
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const SAFE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "EEXIST", "ENOENT", "ENOSPC", "EIO", "ENOTDIR", "EISDIR", "EINVAL",
  "EXDEV", "EROFS", "EMFILE", "ENFILE", "ENAMETOOLONG", "ELOOP"]);
const PRIVATE_JSON_POLICY = Object.freeze({ maximumRenameAttempts: 5, retryDelaysMs: RETRY_DELAYS_MS,
  maximumBackoffMs: RETRY_DELAYS_MS.reduce((sum, value) => sum + value, 0), temporaryMode: 0o600 });
class PrivateAtomicJsonError extends Error {
  constructor(code, error, { renameAttempts = 0, checkpointRetained = false } = {}) {
    super(`Private JSON checkpoint failed (${code}).`);
    this.name = "PrivateAtomicJsonError"; this.code = code;
    this.filesystemCode = SAFE_CODES.has(error?.code) ? error.code : "UNKNOWN";
    this.renameAttempts = renameAttempts; this.checkpointRetained = checkpointRetained;
  }
}
function checkedPath(file, fsImpl) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) throw Error("Invalid checkpoint path.");
  const target = path.resolve(file), directory = path.dirname(target), root = path.parse(directory).root;
  let current = root;
  const rootStat = fsImpl.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error("Invalid checkpoint root.");
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = fsImpl.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Invalid checkpoint directory.");
  }
  try {
    const stat = fsImpl.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Invalid checkpoint target.");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return target;
}
function updatePrivateJson(file, value, { fsImpl = fs } = {}) {
  let target, serialized;
  try { target = checkedPath(file, fsImpl); }
  catch (error) { throw new PrivateAtomicJsonError("PRIVATE_JSON_PATH_FAILED", error); }
  try {
    serialized = JSON.stringify(value, null, 2);
    if (typeof serialized !== "string") throw Error("Value is not JSON.");
    serialized += "\n";
  } catch { throw new PrivateAtomicJsonError("PRIVATE_JSON_SERIALIZATION_FAILED"); }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { fsImpl.writeFileSync(temporary, serialized, { flag: "wx", mode: PRIVATE_JSON_POLICY.temporaryMode }); }
  catch (error) { throw new PrivateAtomicJsonError("PRIVATE_JSON_WRITE_FAILED", error); }
  // Keep the complete owned checkpoint on every replacement failure. Never
  // unlink an existing destination or another writer's temporary checkpoint.
  for (let attempt = 1; attempt <= PRIVATE_JSON_POLICY.maximumRenameAttempts; attempt++) {
    try {
      checkedPath(target, fsImpl);
      const temporaryStat = fsImpl.lstatSync(temporary);
      if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()) throw Error("Invalid temporary checkpoint.");
    } catch (error) {
      throw new PrivateAtomicJsonError("PRIVATE_JSON_PATH_FAILED", error, { renameAttempts: attempt - 1, checkpointRetained: true });
    }
    try {
      fsImpl.renameSync(temporary, target);
      return { ok: true, renameAttempts: attempt, checkpointRetained: false };
    } catch (error) {
      if (!RETRY_CODES.has(error?.code) || attempt === PRIVATE_JSON_POLICY.maximumRenameAttempts)
        throw new PrivateAtomicJsonError("PRIVATE_JSON_REPLACE_FAILED", error, { renameAttempts: attempt, checkpointRetained: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAYS_MS[attempt - 1]);
    }
  }
}
module.exports = { updatePrivateJson, PrivateAtomicJsonError, PRIVATE_JSON_POLICY };
