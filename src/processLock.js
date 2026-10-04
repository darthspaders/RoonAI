"use strict";

const fs = require("node:fs");
const path = require("node:path");

function processIsAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (_) {
    return null;
  }
}

function acquireProcessLock(lockPath, name) {
  const resolvedPath = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(resolvedPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        name: String(name || "process"),
        startedAt: new Date().toISOString()
      }));

      let released = false;
      return {
        path: resolvedPath,
        release() {
          if (released) return;
          released = true;
          try { fs.closeSync(fd); } catch (_) {}
          const owner = readOwner(resolvedPath);
          if (Number(owner?.pid) === process.pid) {
            try { fs.unlinkSync(resolvedPath); } catch (_) {}
          }
        }
      };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (_) {}
      }
      if (error?.code !== "EEXIST") throw error;

      const owner = readOwner(resolvedPath);
      if (processIsAlive(owner?.pid)) {
        const locked = new Error(`${name || "Process"} is already running (pid ${owner.pid}).`);
        locked.code = "EINSTANCE";
        locked.owner = owner;
        throw locked;
      }

      try { fs.unlinkSync(resolvedPath); } catch (cleanupError) {
        const locked = new Error(`${name || "Process"} lock is held by another process.`);
        locked.code = "EINSTANCE";
        locked.cause = cleanupError;
        throw locked;
      }
    }
  }

  const locked = new Error(`${name || "Process"} lock could not be acquired.`);
  locked.code = "EINSTANCE";
  throw locked;
}

module.exports = { acquireProcessLock, processIsAlive };
