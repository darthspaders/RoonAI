"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { fork, spawnSync } = require("node:child_process");
const { acquireProcessLock, processIsAlive } = require("../src/processLock");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OLD_STARTED_AT = "2000-01-01T00:00:00.000Z";

function bounded(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })
  ]).finally(() => clearTimeout(timer));
}

async function stopChild(state) {
  if (state.exited) return;
  let forced = false;
  const timer = setTimeout(() => { forced = true; state.child.kill(); }, 2000);
  try {
    if (state.child.connected) state.child.send({ stop: true });
    await bounded(state.exit, 5000, "Owned lock-test child did not exit.");
    assert.equal(forced, false, "Owned child should release its lock and exit normally.");
  } finally { clearTimeout(timer); }
}

function fixture(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, "rabbit-hole-process-lock-test-"));
  const handles = [];
  const children = [];
  t.after(async () => {
    try {
      for (const child of children) await stopChild(child);
    } finally {
      for (const handle of handles) handle.release();
      const relative = path.relative(temporaryRoot, path.resolve(root));
      assert.ok(relative.startsWith("rabbit-hole-process-lock-test-") && !relative.includes(path.sep) && !path.isAbsolute(relative));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const lockPath = path.join(root, "rabbit-hole.app.lock");
  return { root, lockPath, children, acquire(filename = lockPath) {
    const handle = acquireProcessLock(filename, "Rabbit Hole test");
    handles.push(handle);
    return handle;
  } };
}

async function liveChild(fixture) {
  const filename = path.join(fixture.root, "owned-child.js");
  fs.writeFileSync(filename, `
    "use strict";
    const { acquireProcessLock } = require(${JSON.stringify(require.resolve("../src/processLock"))});
    const handle = acquireProcessLock(process.argv[2], "Owned child test");
    process.on("message", message => {
      if (message?.stop) {
        handle.release();
        process.disconnect();
      }
    });
    process.send({ ready: true, pid: process.pid });
  `);
  const child = fork(filename, [fixture.lockPath], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  const state = { child, exited: false };
  state.exit = new Promise(resolve => {
    child.once("exit", (code, signal) => { state.exited = true; resolve({ code, signal }); });
    child.once("error", error => { state.exited = true; resolve({ error }); });
  });
  fixture.children.push(state);
  const ready = new Promise((resolve, reject) => {
    child.once("message", message => message?.ready ? resolve(message) : reject(new Error("Unexpected child message.")));
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Lock-test child exited before readiness (${code}): ${stderr}`)));
  });
  await bounded(ready, 5000, "Owned lock-test child did not become ready.");
  return state;
}

test("process liveness accepts the current owner and rejects invalid PIDs", () => {
  assert.equal(processIsAlive(process.pid), true);
  for (const pid of [undefined, null, 0, -1, 1.5, NaN, "not-a-pid"]) assert.equal(processIsAlive(pid), false);
});

test("new locks have unique owner IDs and release is idempotent", t => {
  const f = fixture(t);
  const first = f.acquire();
  const owner = JSON.parse(fs.readFileSync(f.lockPath, "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.match(owner.ownerId, UUID);
  assert.equal(first.path, f.lockPath);
  first.release();
  first.release();
  assert.equal(fs.existsSync(f.lockPath), false);
  const second = f.acquire();
  const nextOwner = JSON.parse(fs.readFileSync(f.lockPath, "utf8"));
  assert.match(nextOwner.ownerId, UUID);
  assert.notEqual(nextOwner.ownerId, owner.ownerId);
  second.release();
});

test("legacy lock whose PID now belongs to this newer process is recovered", t => {
  const f = fixture(t);
  fs.writeFileSync(f.lockPath, JSON.stringify({ pid: process.pid, name: "Rabbit Hole app", startedAt: OLD_STARTED_AT }));
  const handle = f.acquire();
  const owner = JSON.parse(fs.readFileSync(f.lockPath, "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.match(owner.ownerId, UUID);
  assert.notEqual(owner.startedAt, OLD_STARTED_AT);
  handle.release();
});

test("legacy lock belonging to an exited real child is recovered", t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const pid = Number(child.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  assert.equal(processIsAlive(pid), false);
  fs.writeFileSync(f.lockPath, JSON.stringify({ pid, name: "Rabbit Hole app", startedAt: OLD_STARTED_AT }));
  const handle = f.acquire();
  assert.equal(JSON.parse(fs.readFileSync(f.lockPath, "utf8")).pid, process.pid);
  handle.release();
});

test("a genuinely live child owner blocks takeover and releases normally", { timeout: 15000 }, async t => {
  const f = fixture(t);
  const state = await liveChild(f);
  const before = fs.readFileSync(f.lockPath, "utf8");
  assert.equal(processIsAlive(state.child.pid), true);
  assert.throws(() => f.acquire(), error => error.code === "EINSTANCE");
  assert.equal(fs.readFileSync(f.lockPath, "utf8"), before);
  await stopChild(state);
  assert.equal(fs.existsSync(f.lockPath), false);
  const handle = f.acquire();
  handle.release();
});

test("same-process double acquisition cannot replace the first active lock", t => {
  const f = fixture(t);
  const first = f.acquire();
  const before = fs.readFileSync(f.lockPath, "utf8");
  assert.throws(() => f.acquire(), error => error.code === "EINSTANCE");
  assert.equal(fs.readFileSync(f.lockPath, "utf8"), before);
  first.release();
  assert.equal(fs.existsSync(f.lockPath), false);
  const next = f.acquire();
  next.release();
});

test("release preserves an externally replaced same-PID lock with a different owner ID", t => {
  const f = fixture(t);
  const handle = f.acquire();
  const replacement = { ...JSON.parse(fs.readFileSync(f.lockPath, "utf8")), ownerId: randomUUID() };
  fs.unlinkSync(f.lockPath);
  const contents = JSON.stringify(replacement);
  fs.writeFileSync(f.lockPath, contents);
  handle.release();
  assert.equal(fs.readFileSync(f.lockPath, "utf8"), contents);
});

test("release preserves a recreated lock inode even if its owner ID was copied", t => {
  const f = fixture(t);
  const handle = f.acquire();
  const contents = fs.readFileSync(f.lockPath, "utf8");
  fs.unlinkSync(f.lockPath);
  fs.writeFileSync(f.lockPath, contents);
  handle.release();
  assert.equal(fs.readFileSync(f.lockPath, "utf8"), contents);
});

test("release checks the owner ID even when the lock file inode is unchanged", t => {
  const f = fixture(t);
  const handle = f.acquire();
  const inode = fs.statSync(f.lockPath).ino;
  const contents = JSON.stringify({ ...JSON.parse(fs.readFileSync(f.lockPath, "utf8")), ownerId: randomUUID() });
  fs.writeFileSync(f.lockPath, contents);
  assert.equal(fs.statSync(f.lockPath).ino, inode);
  handle.release();
  assert.equal(fs.readFileSync(f.lockPath, "utf8"), contents);
});

test("empty, malformed and invalid owner records block without deleting data", t => {
  const f = fixture(t);
  for (const contents of ["", "not JSON", "null", "[]", "{}",
    JSON.stringify({ pid: process.pid }),
    JSON.stringify({ pid: process.pid, startedAt: "not-a-date" }),
    JSON.stringify({ pid: 0, startedAt: OLD_STARTED_AT })]) {
    fs.writeFileSync(f.lockPath, contents);
    assert.throws(() => f.acquire(), error => error.code === "EINSTANCE");
    assert.equal(fs.readFileSync(f.lockPath, "utf8"), contents);
  }
});
