"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

// Keep same-process ownership even if this module is loaded again. Disk PIDs
// alone cannot distinguish an old container from the process starting now.
const registryKey = Symbol.for("rabbit-hole.process-lock.active");
const activeLocks = globalThis[registryKey] ||= new Map();
const processKey = Symbol.for("rabbit-hole.process-lock.generation");
const processGeneration = globalThis[processKey] ||= crypto.randomUUID();
const START_TIME_SLACK_MS = 2000;
let clockTicks;
const validBootId = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

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

function linuxIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    const startTicks = stat.slice(closingParen + 2).trim().split(/\s+/)[19];
    if (!validBootId(bootId) || closingParen < 0 || !/^\d+$/.test(startTicks || "")) return null;
    return { bootId: bootId.toLowerCase(), startTicks };
  } catch (_) { return null; }
}

function legacyProcessStartedAt(pid) {
  if (process.platform !== "linux") return null;
  try {
    const identity = linuxIdentity(pid);
    if (!identity) return null;
    // Only old PID/timestamp locks need a wall-clock estimate. New records use
    // raw kernel identity, avoiding clock changes and tick-rate assumptions.
    if (clockTicks === undefined) {
      try {
        const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1000, windowsHide: true }).trim());
        clockTicks = Number.isFinite(ticks) && ticks > 0 ? ticks : null;
      } catch (_) { clockTicks = null; }
    }
    if (!clockTicks) return null;
    const boot = fs.readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m);
    if (!boot) return null;
    const result = Number(boot[1]) * 1000 + Number(identity.startTicks) / clockTicks * 1000;
    return Number.isFinite(result) ? result : null;
  } catch (_) { return null; }
}

function validOwner(owner) {
  return owner && typeof owner === "object" && !Array.isArray(owner) &&
    Number.isInteger(Number(owner.pid)) && Number(owner.pid) > 0 &&
    Number.isFinite(Date.parse(owner.startedAt));
}

function ownerStillRunning(owner) {
  const pid = Number(owner.pid);
  if (!processIsAlive(pid)) return false;
  if (owner.linux) {
    const identity = linuxIdentity(pid);
    if (!identity || !validBootId(owner.linux.bootId) ||
        typeof owner.linux.startTicks !== "string" || !/^\d+$/.test(owner.linux.startTicks)) return true;
    return identity.bootId === owner.linux.bootId.toLowerCase() && identity.startTicks === owner.linux.startTicks;
  }
  // Old records did not save kernel identity. Active ownership is checked by
  // the registry before this branch, so a leftover own-PID record is stale.
  if (pid === process.pid) return owner.processId === processGeneration;
  const startedAt = legacyProcessStartedAt(pid);
  return startedAt === null || startedAt <= Date.parse(owner.startedAt) + START_TIME_SLACK_MS;
}

function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }

function readOwner(lockPath) {
  try {
    const fd = fs.openSync(lockPath, "r");
    try { return { owner: JSON.parse(fs.readFileSync(fd, "utf8")), stat: fs.fstatSync(fd) }; }
    finally { fs.closeSync(fd); }
  } catch (_) {
    return null;
  }
}

function blocked(name, owner, detail = "") {
  const message = detail || `${name || "Process"} is already running (pid ${owner?.pid}).`;
  return Object.assign(new Error(message), { code: "EINSTANCE", owner });
}

function acquireProcessLock(lockPath, name) {
  const resolvedPath = path.resolve(lockPath);
  const registryPath = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  if (activeLocks.has(registryPath)) throw blocked(name, activeLocks.get(registryPath));
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(resolvedPath, "wx", 0o600);
      const owner = {
        pid: process.pid,
        name: String(name || "process"),
        startedAt: new Date().toISOString(),
        ownerId: crypto.randomUUID(),
        processId: processGeneration
      };
      const identity = linuxIdentity(process.pid);
      if (identity) owner.linux = identity;
      try { fs.writeFileSync(fd, JSON.stringify(owner)); }
      catch (writeError) {
        // A failed write may leave a partial file. Remove only our own inode.
        try { if (sameFile(fs.fstatSync(fd), fs.statSync(resolvedPath))) fs.unlinkSync(resolvedPath); } catch (_) {}
        throw writeError;
      }
      const ownedStat = fs.fstatSync(fd);
      activeLocks.set(registryPath, owner);

      let released = false;
      return {
        path: resolvedPath,
        release() {
          if (released) return;
          released = true;
          try { fs.closeSync(fd); } catch (_) {}
          const current = readOwner(resolvedPath);
          if (current?.owner?.ownerId === owner.ownerId && sameFile(ownedStat, current.stat)) {
            try { fs.unlinkSync(resolvedPath); } catch (_) {}
          }
          if (activeLocks.get(registryPath)?.ownerId === owner.ownerId) activeLocks.delete(registryPath);
        }
      };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (_) {}
      }
      if (error?.code !== "EEXIST") throw error;

      const previous = readOwner(resolvedPath);
      if (!validOwner(previous?.owner)) throw blocked(name, previous?.owner,
        `${name || "Process"} lock ownership is unreadable. Confirm all owners have stopped before recovering it.`);
      if (ownerStillRunning(previous.owner)) throw blocked(name, previous.owner);

      // A competitor may have replaced the stale record since we read it.
      // Never remove the replacement. This is not a distributed volume lock.
      const current = readOwner(resolvedPath);
      if (!current || !sameFile(previous.stat, current.stat) ||
          JSON.stringify(previous.owner) !== JSON.stringify(current.owner)) throw blocked(name, current?.owner,
        `${name || "Process"} lock changed during recovery; retry after the other starter finishes.`);

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
