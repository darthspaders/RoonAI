"use strict";
// Fake-process tests exercise both unchanged worker and new ownership wrapper
// source. No real WSL process, Python helper, GPU, provider or database is used.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
function harness(t, options = {}) {
  const processLike = { platform: "win32", env: { WSLENV: "PATH/l:EXAMPLE/u", RABBIT_HOLE_SCOUT_WORKER_OWNER: "preserved-parent-value" } }, environmentBefore = { ...processLike.env };
  const children = [], spawnCalls = [], timers = new Set(), owned = new Map(), signalCalls = []; let now = 0;
  class Child extends EventEmitter {
    constructor(pid) { super(); this.pid = pid; this.exitCode = null; this.signalCode = null; this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.stdin = new EventEmitter(); this.writes = []; this.kills = 0;
      this.stdin.write = value => { this.writes.push(JSON.parse(value)); return true; }; this.stdin.end = () => { this.ended = true; }; }
    kill() { this.kills++; if (options.exitOnKill !== false) { this.exitCode = 0; this.emit("exit", 0); } return options.exitOnKill !== false; }
    send(message) { this.stdout.write(JSON.stringify(message) + "\n"); }
  }
  const spawn = (command, args) => { const child = new Child(9000 + children.length), linuxPid = 25000 + children.length;
    spawnCalls.push({ command, args: Array.from(args), environment: { ...processLike.env } });
    assert.ok(!args.includes("kill"), "Original numeric-PID cleanup must be suppressed by the wrapper.");
    child.fixturePid = linuxPid; child.fixtureOwner = processLike.env.RABBIT_HOLE_SCOUT_WORKER_OWNER;
    owned.set(linuxPid, { pid: linuxPid, startTicks: String(100000 + linuxPid), command: "synthetic owned worker", tagMatched: true, owner: options.missingTag ? "foreign-owner" : child.fixtureOwner });
    children.push(child); return child; };
  const context = { process: processLike, __dirname: path.resolve(__dirname, "../src"), setTimeout(fn, ms) { const timer = { fn, ms, unref() { return this; } }; timers.add(timer); return timer; }, clearTimeout(timer) { timers.delete(timer); } };
  const base = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(context.__dirname, "sonicAnalysisWorker.js"), "utf8"), { ...context, module: base, exports: base.exports,
    require: name => name === "node:child_process" ? { spawn } : require(name) });
  const wrapper = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(context.__dirname, "sonicCatalogScoutOperationalWorker.js"), "utf8"), { ...context, module: wrapper, exports: wrapper.exports,
    require: name => name === "./sonicAnalysisWorker" ? base.exports : name === "node:child_process" ? { execFile() { throw new Error("Real process helpers are forbidden in this test."); } } : require(name) });
  const ownership = { async list(owner) { if (options.listError) throw new Error("Synthetic ownership reader failure"); return [...owned.values()].filter(row => row.owner === owner).map(row => ({ ...row })); },
    async signal(owner, targets, signal) { signalCalls.push({ owner, targets, signal });
      return targets.map(target => { if (options.reusePid) { const replacement = owned.get(target.pid); if (replacement) owned.set(target.pid, { ...replacement, owner: "foreign-owner", startTicks: "999999" }); }
        const row = owned.get(target.pid), sent = Boolean(row && row.owner === owner && row.startTicks === target.startTicks);
        if (sent && (signal === "KILL" || !options.ignoreTerm)) owned.delete(target.pid);
        return { ...target, signal, sent, reason: sent ? "exact-owned-process" : "start-ticks-or-tag-changed" }; }); } };
  const worker = new wrapper.exports.OwnedOperationalWorker({ timeoutMs: 100, idleMs: 50, readyTimeoutMs: 100, releaseTimeoutMs: 400,
    pollMs: 10, termGraceMs: 20, quietScans: 2, ownership, clock: () => now,
    sleep: async ms => { now += ms; if (options.autoReady !== false) for (const child of children) if (child.linuxPid === undefined && child.exitCode === null) child.send({ ready: true, pid: child.fixturePid }); } });
  t.after(() => { worker.stop(); for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); } });
  return { worker, owned, children, spawnCalls, signalCalls, environmentBefore, processLike, timers, spec: { runtime: "mert2" },
    latest: () => children.at(-1), finish(result = { fixture: true }) { const child = children.at(-1); child.send({ id: child.writes.at(-1).id, result }); },
    fire(ms) { const matching = [...timers].filter(timer => timer.ms === ms); assert.equal(matching.length, 1); timers.delete(matching[0]); matching[0].fn(); },
    async requested() { for (let index = 0; index < 20; index++) { if (children.at(-1)?.writes.length) return; await Promise.resolve(); } assert.fail("Expected one fake accepted request."); } };
}
const copy = value => JSON.parse(JSON.stringify(value));

test("ownership tagging is scoped to its spawn and no request starts before verified readiness", async t => {
  const h = harness(t), pending = h.worker.run("C:/private/fixture.audio", h.spec); assert.equal(h.latest().writes.length, 0); assert.deepEqual(h.processLike.env, h.environmentBefore);
  assert.match(h.spawnCalls[0].environment.RABBIT_HOLE_SCOUT_WORKER_OWNER, /^[a-f0-9-]{36}$/);
  assert.equal(h.spawnCalls[0].environment.WSLENV, "PATH/l:EXAMPLE/u:RABBIT_HOLE_SCOUT_WORKER_OWNER");
  await h.requested(); assert.equal(h.worker.readyEvidence.pid, h.latest().fixturePid); assert.equal(h.latest().writes.length, 1);
  h.finish({ ok: true }); assert.deepEqual(copy(await pending), { ok: true }); const release = await h.worker.release(); assert.equal(release.confirmed, true); assert.equal(release.readyOwnershipVerified, true); assert.equal(h.owned.size, 0);
});
test("tagged pre-ready cancellation retains the child handle and releases only exact owned processes", async t => {
  const h = harness(t, { autoReady: false }); h.worker.start("mert2"); const child = h.worker.ownedChild, rows = await h.worker.ownedProcesses();
  assert.equal(rows.length, 1); assert.equal(child.linuxPid, undefined); assert.equal(child.writes.length, 0); assert.deepEqual(Object.keys(rows[0]).sort(), ["command", "pid", "startTicks"]);
  h.worker.stop(); assert.equal(h.worker.ownedChild, child); const release = await h.worker.release();
  assert.equal(release.confirmed, true); assert.equal(release.readyOwnershipVerified, false); assert.equal(release.tagPropagationVerified, true); assert.equal(release.ownedLinuxProcessesRemaining, 0); assert.equal(h.worker.ownedChild, null);
  assert.equal(h.signalCalls.length, 1); assert.equal(h.signalCalls[0].signal, "TERM"); assert.deepEqual(copy(h.signalCalls[0].targets), [{ pid: rows[0].pid, startTicks: rows[0].startTicks }]);
});
test("ready request timeout requires owned release before a fresh successful recovery", async t => {
  const h = harness(t), pending = h.worker.run("C:/private/fixture.audio", h.spec), rejected = assert.rejects(pending, /timed out/); await h.requested(); const child = h.latest();
  h.fire(100); await rejected; assert.equal(child.kills, 1); assert.ok(h.worker.lastLinuxPID); assert.throws(() => h.worker.start("mert2"), /Release the prior/);
  const release = await h.worker.release(); assert.equal(release.confirmed, true); assert.equal(h.owned.size, 0);
  const recovered = h.worker.run("C:/private/fixture.audio", h.spec); await h.requested(); assert.notEqual(h.latest(), child); h.finish({ recovered: true }); assert.deepEqual(copy(await recovered), { recovered: true }); await h.worker.release();
});
test("cancellation during readiness accepts zero requests and still cleans up its tagged launch", async t => {
  const h = harness(t, { autoReady: false }), pending = h.worker.run("C:/private/fixture.audio", h.spec), rejected = assert.rejects(pending, /stopped before verified readiness/);
  h.worker.stop(); await rejected; assert.equal(h.latest().writes.length, 0); assert.equal((await h.worker.release()).confirmed, true); assert.equal(h.owned.size, 0);
});
test("missing ready ownership tags block model work and cannot produce a false cleanup confirmation", async t => {
  const h = harness(t, { missingTag: true }), pending = h.worker.run("C:/private/fixture.audio", h.spec);
  await assert.rejects(pending, /ownership tag could not be verified/); assert.equal(h.latest().writes.length, 0);
  await assert.rejects(h.worker.release(), /Ownership tag was never observed/); assert.equal(h.signalCalls.length, 0); assert.throws(() => h.worker.start("mert2"), /Release the prior/);
});
test("TERM escalation to KILL stays within nonce and exact start-tick ownership", async t => {
  const h = harness(t, { ignoreTerm: true }); h.worker.start("mert2"); await h.worker.awaitReady(); const rows = await h.worker.ownedProcesses();
  const release = await h.worker.release(); assert.equal(release.confirmed, true); assert.deepEqual(h.signalCalls.map(row => row.signal), ["TERM", "KILL"]);
  assert.ok(h.signalCalls.every(row => row.targets[0].pid === rows[0].pid && row.targets[0].startTicks === rows[0].startTicks)); assert.equal(h.owned.size, 0);
});
test("PID reuse or tag loss between inspection and signaling never signals the foreign replacement", async t => {
  const h = harness(t, { reusePid: true }); h.worker.start("mert2"); await h.worker.awaitReady(); const pid = h.latest().fixturePid;
  const release = await h.worker.release(); assert.equal(release.confirmed, true); assert.ok(release.signals.every(row => row.sent === false)); assert.equal(h.owned.get(pid).owner, "foreign-owner");
});
test("a child error or failed kill does not count as Windows child exit", async t => {
  const h = harness(t, { exitOnKill: false }); h.worker.start("mert2"); await h.worker.awaitReady(); const child = h.latest();
  child.emit("error", new Error("Synthetic kill failure")); await assert.rejects(h.worker.release(), /release could not be confirmed/);
  assert.equal(h.owned.size, 0); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); assert.ok(child.pid > 0);
});
test("concurrent readiness/runs and runtime switching cannot launch a second worker before release", async t => {
  const h = harness(t), pending = h.worker.run("C:/private/fixture.audio", h.spec);
  await assert.rejects(h.worker.run("C:/private/second.audio", h.spec), /concurrency is limited to one/); await h.requested(); assert.equal(h.children.length, 1);
  assert.throws(() => h.worker.start("mert1"), /Release the prior/); h.finish(); await pending; await h.worker.release(); assert.equal(h.children.length, 1);
});
test("ownership reader failures stop the wrapper but never signal unverified Linux processes", async t => {
  const h = harness(t, { listError: true }); h.worker.start("mert2"); await assert.rejects(h.worker.release(), /ownership reader failure/);
  assert.equal(h.latest().kills, 1); assert.equal(h.signalCalls.length, 0); assert.equal(h.owned.size, 1); assert.throws(() => h.worker.start("mert2"), /Release the prior/);
});
test("readiness timeout sends no model request and tagged release can recover pre-ready ownership", async t => {
  const h = harness(t, { autoReady: false }), pending = h.worker.run("C:/private/fixture.audio", h.spec); await assert.rejects(pending, /readiness timed out/);
  assert.equal(h.latest().writes.length, 0); const release = await h.worker.release(); assert.equal(release.confirmed, true); assert.equal(release.readyOwnershipVerified, false);
});
