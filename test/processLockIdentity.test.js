"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "processLock.js"), "utf8");
const bootId = "11111111-1111-4111-8111-111111111111";
const priorBootId = "22222222-2222-4222-8222-222222222222";
const selfPid = 424242;
const ownerPid = 424240;

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-lock-identity-"));
  const lockPath = path.join(directory, "app.lock");
  const handles = [];
  const getconfCalls = [];
  const state = {
    bootId, ticks: { [selfPid]: "30000", [ownerPid]: "20000" },
    bootSeconds: 1000000, missingProc: false, ...options
  };
  const fakeFs = {
    ...fs,
    openSync(file, flags, ...rest) {
      state.beforeOpen?.(file, flags, lockPath);
      return fs.openSync(file, flags, ...rest);
    },
    readFileSync(file, ...rest) {
      if (typeof file === "string" && file.startsWith("/proc/")) {
        if (state.missingProc) throw Object.assign(new Error("proc unavailable"), { code: "EACCES" });
        if (file === "/proc/sys/kernel/random/boot_id") return `${state.bootId}\n`;
        if (file === "/proc/stat") return `btime ${state.bootSeconds}\n`;
        const pid = file.match(/^\/proc\/(\d+)\/stat$/)?.[1];
        if (!pid || state.ticks[pid] === undefined) throw Object.assign(new Error("no such process"), { code: "ENOENT" });
        const fields = Array(50).fill("0");
        fields[0] = "S";
        fields[19] = state.ticks[pid];
        // Parentheses and spaces are legal in comm; locate the final ')'.
        return `${pid} (fixture (node) process) ${fields.join(" ")}\n`;
      }
      return fs.readFileSync(file, ...rest);
    },
    writeFileSync(file, value, ...rest) {
      if (typeof file === "number" && state.beforeWrite) state.beforeWrite(file, value, lockPath);
      return fs.writeFileSync(file, value, ...rest);
    }
  };
  const context = vm.createContext({
    process: {
      pid: selfPid, platform: "linux",
      kill(pid, signal) {
        assert.equal(signal, 0);
        if (state.ticks[pid] !== undefined) return true;
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
    },
    require(name) {
      if (name === "node:fs") return fakeFs;
      if (name === "node:child_process") return {
        execFileSync(command, args, execOptions) {
          getconfCalls.push({ command, args: Array.from(args), timeout: execOptions.timeout });
          if (state.getconfError) throw new Error("getconf unavailable");
          return `${state.clockTicks || 1000}\n`;
        }
      };
      return require(name);
    }
  });
  function load() {
    context.module = { exports: {} };
    // Wrap the CommonJS source so module reloads share global state but not
    // top-level const bindings, just as separate require evaluations do.
    vm.runInContext(`(function () {\n${source}\n})();`, context);
    return context.module.exports;
  }
  const api = load();
  t.after(() => {
    for (const handle of handles) handle.release();
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    state, lockPath, getconfCalls, load,
    write(owner) { fs.writeFileSync(lockPath, JSON.stringify(owner)); },
    read() { return JSON.parse(fs.readFileSync(lockPath, "utf8")); },
    acquire(module = api) {
      const handle = module.acquireProcessLock(lockPath, "Fixture app");
      handles.push(handle);
      return handle;
    }
  };
}

function newOwner(linux = { bootId, startTicks: "20000" }) {
  return {
    pid: ownerPid, name: "Fixture app", startedAt: "2000-01-01T00:00:00.000Z",
    ownerId: "previous-lock", processId: "previous-process", linux
  };
}

test("raw Linux identity blocks a genuine owner independently of wall-clock changes", t => {
  const f = fixture(t, { bootSeconds: 2000000000 });
  const owner = newOwner();
  f.write(owner);
  assert.throws(() => f.acquire(), error => error.code === "EINSTANCE");
  assert.deepEqual(f.read(), owner);
  assert.equal(f.getconfCalls.length, 0, "New records must not use clock conversion");
});

test("a live PID with different start ticks is a recoverable reused PID", t => {
  const f = fixture(t);
  f.write(newOwner({ bootId, startTicks: "19999" }));
  f.acquire();
  const owner = f.read();
  assert.equal(owner.pid, selfPid);
  assert.deepEqual(owner.linux, { bootId, startTicks: "30000" });
  assert.equal(f.getconfCalls.length, 0);
});

test("an owner from a previous boot is recoverable even when its PID and ticks match", t => {
  const f = fixture(t);
  f.write(newOwner({ bootId: priorBootId, startTicks: "20000" }));
  f.acquire();
  assert.equal(f.read().linux.bootId, bootId);
});

test("malformed stored Linux identity cannot authorize removing a live owner's file", t => {
  for (const linux of [
    { bootId: "", startTicks: "20000" },
    { bootId, startTicks: 20000 },
    { bootId: "not-a-boot-id", startTicks: "20000" }
  ]) {
    const f = fixture(t);
    const owner = newOwner(linux);
    f.write(owner);
    assert.throws(() => f.acquire(), error => error.code === "EINSTANCE", JSON.stringify(linux));
    assert.deepEqual(f.read(), owner);
  }
});

test("unavailable proc identity conservatively preserves a live owner", t => {
  const f = fixture(t, { missingProc: true });
  const owner = newOwner();
  f.write(owner);
  assert.throws(() => f.acquire(), error => error.code === "EINSTANCE");
  assert.deepEqual(f.read(), owner);
});

test("legacy PID timestamps use the detected tick rate instead of hardcoded 100", t => {
  const f = fixture(t, { clockTicks: 1000 });
  const owner = { pid: ownerPid, name: "Fixture app", startedAt: new Date(1000021000).toISOString() };
  f.write(owner);
  // Start was boot + 20 s; a 100-tick divisor would falsely place it at +200 s.
  assert.throws(() => f.acquire(), error => error.code === "EINSTANCE");
  assert.deepEqual(f.read(), owner);
  assert.deepEqual(f.getconfCalls, [{ command: "getconf", args: ["CLK_TCK"], timeout: 1000 }]);
  f.state.ticks[ownerPid] = "24000";
  f.acquire();
  assert.equal(f.read().pid, selfPid);
  assert.equal(f.getconfCalls.length, 1, "Tick-rate discovery is bounded and cached");
});

test("unavailable tick-rate discovery conservatively preserves a legacy live owner", t => {
  const f = fixture(t, { getconfError: true });
  const owner = { pid: ownerPid, name: "Fixture app", startedAt: "2000-01-01T00:00:00.000Z" };
  f.write(owner);
  assert.throws(() => f.acquire(), error => error.code === "EINSTANCE");
  assert.deepEqual(f.read(), owner);
});

test("a replacement discovered during stale recovery is never removed", t => {
  let reads = 0;
  const replacement = newOwner();
  const f = fixture(t, {
    beforeOpen(file, flags, lockPath) {
      if (file === lockPath && flags === "r" && ++reads === 2) {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, JSON.stringify(replacement));
      }
    }
  });
  f.write(newOwner({ bootId, startTicks: "19999" }));
  assert.throws(() => f.acquire(), error => error.code === "EINSTANCE" && /changed during recovery/.test(error.message));
  assert.deepEqual(f.read(), replacement);
});

test("a failed fresh write removes its own partial inode and permits a clean retry", t => {
  let fail = true;
  const f = fixture(t, {
    beforeWrite(fd) {
      if (!fail) return;
      fail = false;
      fs.writeFileSync(fd, "{partial");
      throw Object.assign(new Error("fixture write failure"), { code: "EIO" });
    }
  });
  assert.throws(() => f.acquire(), error => error.code === "EIO");
  assert.equal(fs.existsSync(f.lockPath), false);
  f.acquire();
  assert.equal(f.read().pid, selfPid);
});

test("failed-write cleanup preserves a replacement inode", t => {
  const replacement = newOwner();
  const f = fixture(t, {
    beforeWrite(_fd, _value, lockPath) {
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, JSON.stringify(replacement));
      throw Object.assign(new Error("fixture write failure"), { code: "EIO" });
    }
  });
  assert.throws(() => f.acquire(), error => error.code === "EIO");
  assert.deepEqual(f.read(), replacement);
});

test("module reload retains same-process ownership and rejects duplicate acquisition", t => {
  const f = fixture(t);
  const first = f.acquire();
  const original = f.read();
  const reloaded = f.load();
  assert.throws(() => f.acquire(reloaded), error => error.code === "EINSTANCE");
  assert.deepEqual(f.read(), original);
  first.release();
  const second = f.acquire(reloaded);
  assert.notEqual(f.read().ownerId, original.ownerId);
  first.release();
  assert.equal(fs.existsSync(f.lockPath), true, "An old handle cannot delete the next acquisition");
  second.release();
});
